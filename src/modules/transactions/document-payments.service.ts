import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Knex } from "knex";
import { phpRound } from "../../common/utils/php-compat";
import { WriteContext } from "../../core/request/write-context";
import { postInt, postString } from "../../core/utils/form-values";
import { BankLedgerEntry, JournalService } from "../../libraries/journal/journal.service";
import { DocumentPaymentsRepository } from "./document-payments.repository";
import { Form } from "./transaction-form";
import { DocumentKind } from "./transaction-kinds";
import { buildUniqueNumber } from "./transaction-number";
import { TransactionsRepository } from "./transactions.repository";

type Row = Record<string, unknown>;

// 110 = payments received (In), 111 = payments made (Out)
export const PAYMENT_IN_MODULE = 110;
export const PAYMENT_OUT_MODULE = 111;

export type PaymentDirection = "In" | "Out";

export interface PaymentRowsResult {
  totalPaid: number;
  firstPaymentUID: number | null;
}

export interface PaymentNumber {
  prefixUID: number | null;
  paymentNumber: number;
  uniqueNumber: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const num = (value: unknown) => Number(value ?? 0) || 0;

/**
 * Payments recorded against transaction documents (CI3 MY_Controller::_savePaymentRecord, _updateTransactionBalance,
 * _buildPaymentUniqueNumber): numbering on the payments prefix, the PaymentsTbl rows and their bank / cash book lines.
 */
@Injectable()
export class DocumentPaymentsService {
  constructor(
    readonly repo: DocumentPaymentsRepository,
    private readonly reads: TransactionsRepository,
    private readonly journal: JournalService
  ) {}

  /**
   * _savePaymentRecord — the PaymentRows JSON posted with a document form, inside its transaction. Rows without a
   * payment type or amount are skipped; the last row carries IsFullyPaid and any amount paid over the bill. The
   * returned total is the sum of every posted row, as in CI3.
   */
  async saveFormRows(
    trx: Knex.Transaction,
    kind: DocumentKind,
    ctx: WriteContext,
    doc: { transUID: number; partyUID: number; billTotal: number; transDate: string },
    form: Form,
    direction: PaymentDirection,
    options: { standardNumbers?: boolean; bankBook?: boolean } = {}
  ): Promise<PaymentRowsResult> {
    const posted = postString(form, "PaymentRows") ?? "";
    if (!posted) return { totalPaid: 0, firstPaymentUID: null };
    let rows: Row[];
    try {
      rows = JSON.parse(posted);
    } catch {
      return { totalPaid: 0, firstPaymentUID: null };
    }
    if (!Array.isArray(rows) || rows.length === 0) return { totalPaid: 0, firstPaymentUID: null };

    const { orgUID, userUID } = ctx;
    const paymentModuleUID = direction === "In" ? PAYMENT_IN_MODULE : PAYMENT_OUT_MODULE;
    const isFullyPaid = postInt(form, "IsFullyPaid") === 1 ? 1 : 0;
    const totalPaid = rows.reduce((total, row) => total + num(row.amount), 0);
    const [prefix] = await this.reads.prefixes(orgUID, paymentModuleUID, undefined, trx);
    const numbers = new Map<number, number>();
    let firstPaymentUID: number | null = null;

    for (const [index, row] of rows.entries()) {
      const paymentTypeUID = Math.trunc(num(row.paymentTypeUID));
      const amount = num(row.amount);
      const date = typeof row.paymentDate === "string" && DATE.test(row.paymentDate) ? row.paymentDate : doc.transDate;
      if (paymentTypeUID <= 0 || amount <= 0) continue;
      const year = Number(date.slice(0, 4));
      const isLast = index === rows.length - 1;

      // One lookup per year, then counted on (rows saved earlier in this transaction are not committed yet)
      let paymentNumber = 0;
      if (prefix) {
        paymentNumber = numbers.has(year) ? numbers.get(year)! + 1 : await this.repo.nextPaymentNumber(trx, orgUID, Number(prefix.PrefixUID), year);
        numbers.set(year, paymentNumber);
      }
      const uniqueNumber = prefix && paymentNumber > 0 ? buildUniqueNumber(options.standardNumbers ? { ...prefix, ComponentConfig: null } : prefix, paymentNumber, date) : null;
      const bankAccountUID = Math.trunc(num(row.bankAccountUID)) || null;
      const referenceNo = row.referenceNo ? String(row.referenceNo) : null;

      const paymentUID = await this.repo.insertPayment(trx, {
        OrgUID: orgUID,
        BranchUID: ctx.branchUID ?? 1,
        PaymentDate: date,
        PaymentModuleUID: paymentModuleUID,
        PrefixUID: prefix ? Number(prefix.PrefixUID) : null,
        PaymentNumber: paymentNumber,
        UniqueNumber: uniqueNumber,
        ReceiptToken: randomUUID(),
        TransYear: year,
        TransUID: doc.transUID,
        ModuleUID: kind.moduleUID,
        PartyType: kind.partyType,
        PartyUID: doc.partyUID,
        PaymentTypeUID: paymentTypeUID,
        Amount: amount,
        BankAccountUID: bankAccountUID,
        ReferenceNo: referenceNo,
        Notes: row.notes ? String(row.notes) : null,
        PaymentSource: "Create",
        PaymentDirection: direction,
        IsFullyPaid: isLast ? isFullyPaid : 0,
        ExcessAmount: isLast && doc.billTotal > 0 && totalPaid > doc.billTotal ? phpRound(totalPaid - doc.billTotal, 4) : 0,
        AppliedToTransUID: null,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      if (index === 0) firstPaymentUID = paymentUID;

      if (options.bankBook === false) continue;
      await this.journal.writeBankLedgerEntry(
        {
          orgUID,
          bankAccountUID,
          entryType: direction === "In" ? "CR" : "DR",
          amount,
          sourceType: direction === "In" ? "Invoice" : "Purchase",
          sourceUID: doc.transUID,
          moduleUID: kind.moduleUID,
          referenceNo,
          narration: `${direction === "In" ? "Payment received – " : "Payment made to vendor – "}${uniqueNumber ?? `#${doc.transUID}`}`,
          entryDate: date,
          userUID,
        },
        trx
      );
    }
    return { totalPaid, firstPaymentUID };
  }

  /**
   * The next number on the payments prefix of a direction. standardOnly: built from the prefix columns alone
   * (the CI3 screens that format the number inline ignore the prefix builder's ComponentConfig).
   */
  async nextNumber(trx: Knex.Transaction, orgUID: number, paymentModuleUID: number, date: string, standardOnly = false): Promise<PaymentNumber> {
    const [prefix] = await this.reads.prefixes(orgUID, paymentModuleUID, undefined, trx);
    if (!prefix) return { prefixUID: null, paymentNumber: 0, uniqueNumber: null };
    const paymentNumber = await this.repo.nextPaymentNumber(trx, orgUID, Number(prefix.PrefixUID), Number(date.slice(0, 4)));
    const uniqueNumber = paymentNumber > 0 ? buildUniqueNumber(standardOnly ? { ...prefix, ComponentConfig: null } : prefix, paymentNumber, date) : null;
    return { prefixUID: Number(prefix.PrefixUID), paymentNumber, uniqueNumber };
  }

  // getPaymentAttachments — every payment's files, each with its payment's mode, amount and number
  async paymentAttachments(orgUID: number, transUID: number) {
    const payments = await this.reads.payments(orgUID, transUID);
    const byUID = new Map(payments.map((payment) => [Number(payment.PaymentUID), payment]));
    const files = await this.repo.paymentAttachments(orgUID, [...byUID.keys()]);
    return {
      Attachments: files.map((file) => {
        const payment = byUID.get(Number(file.PaymentUID));
        return { ...file, PaymentTypeName: payment?.PaymentTypeName ?? null, PaymentAmount: payment?.Amount ?? null, PaymentUniqueNumber: payment?.UniqueNumber ?? null };
      }),
    };
  }

  // _writeBankLedgerEntry — one line in the bank / cash book (non-fatal)
  writeBankEntry(ctx: WriteContext, entry: Omit<BankLedgerEntry, "orgUID" | "userUID">): Promise<void> {
    return this.journal.writeBankLedgerEntry({ ...entry, orgUID: ctx.orgUID, userUID: ctx.userUID });
  }

  // _updateTransactionBalance — paid, balance and fully-paid from the bill amount and what has been paid
  async applyPaid(trx: Knex.Transaction, orgUID: number, transUID: number, netAmount: number, paid: number, userUID: number): Promise<void> {
    const balance = phpRound(netAmount - paid, 4);
    await this.repo.setPaid(trx, orgUID, transUID, { isFullyPaid: netAmount > 0 && balance <= 0 ? 1 : 0, paidAmount: paid, balanceAmount: Math.max(0, balance) }, userUID);
  }
}
