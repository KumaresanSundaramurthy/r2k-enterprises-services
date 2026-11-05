import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Knex } from "knex";
import { todayDate } from "../../common/utils/php-compat";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { DocumentPaymentsRepository } from "./document-payments.repository";
import { DocumentPaymentsService, PAYMENT_IN_MODULE } from "./document-payments.service";
import { buildUniqueNumber } from "./transaction-number";
import { TransactionsRepository } from "./transactions.repository";

type Row = Record<string, unknown>;

// Prefix modules of the notes
const CREDIT_NOTE_MODULE = 107;
const DEBIT_NOTE_MODULE = 109;

/**
 * Customer credit and debit notes (CI3 Customerbalance library): the credit note of a cancelled / deleted paid
 * invoice or of a sales return not refunded, the debit note of a refunded sales return being recovered, and
 * applying / refunding a credit note. Notes are numbered org-wide on their own prefix and never re-issued.
 */
@Injectable()
export class CustomerNotesService {
  constructor(
    readonly repo: DocumentPaymentsRepository,
    private readonly reads: TransactionsRepository,
    private readonly payments: DocumentPaymentsService,
    private readonly audit: AuditLogService
  ) {}

  /**
   * createCreditNote — what the customer paid on an invoice being cancelled / deleted becomes a Pending credit
   * note; those payments are marked transferred. Null when nothing was paid.
   */
  async createInvoiceCreditNote(trx: Knex.Transaction, ctx: WriteContext, customerUID: number, transUID: number, invoiceNumber: string): Promise<{ creditNoteUID: number; amount: number } | null> {
    const paid = await this.repo.untransferredPaid(trx, ctx.orgUID, transUID);
    if (paid <= 0) return null;
    const { prefixUID, seq, number } = await this.numbered(trx, ctx.orgUID, "credit", todayDate(), false);
    await this.repo.markTransferred(trx, ctx.orgUID, transUID, ctx.userUID);
    const creditNoteUID = await this.repo.insertCustomerCreditNote(trx, {
      OrgUID: ctx.orgUID,
      PartyUID: customerUID,
      PartyType: "C",
      SourceTransUID: transUID,
      SourceTransNumber: invoiceNumber,
      SourceModuleUID: 103,
      CreditNoteNumber: number,
      CreditNoteToken: randomUUID(),
      CreditNoteSeq: seq,
      CreditNoteType: "Invoice",
      PrefixUID: prefixUID,
      Amount: paid,
      Status: "Pending",
      Notes: "Auto-created on invoice cancellation",
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
      IsActive: 1,
      IsDeleted: 0,
    });
    await this.log(ctx, "CREATE_CREDIT_NOTE", creditNoteUID, number, `Credit Note ${number || `#${creditNoteUID}`} auto-created from cancelled Invoice ${invoiceNumber || `#${transUID}`}`, "Invoices", {
      amount: paid,
      sourceTransUID: transUID,
      sourceTransNumber: invoiceNumber,
      type: "Invoice",
    });
    return { creditNoteUID, amount: paid };
  }

  // createSalesReturnCreditNote — the part of a sales return not refunded, numbered on the return's date
  async createSalesReturnCreditNote(trx: Knex.Transaction, ctx: WriteContext, customerUID: number, transUID: number, returnNumber: string, amount: number, transDate: string) {
    if (amount <= 0) return null;
    const { prefixUID, seq, number } = await this.numbered(trx, ctx.orgUID, "credit", transDate || todayDate(), true);
    const creditNoteUID = await this.repo.insertCustomerCreditNote(trx, {
      OrgUID: ctx.orgUID,
      PartyUID: customerUID,
      PartyType: "C",
      SourceTransUID: transUID,
      SourceTransNumber: returnNumber,
      SourceModuleUID: 106,
      CreditNoteNumber: number,
      CreditNoteToken: randomUUID(),
      CreditNoteSeq: seq,
      CreditNoteType: "SalesReturn",
      PrefixUID: prefixUID,
      Amount: amount,
      Status: "Pending",
      Notes: `Auto-created from Sales Return ${returnNumber}`,
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
      IsActive: 1,
      IsDeleted: 0,
    });
    await this.log(ctx, "CREATE_CREDIT_NOTE", creditNoteUID, number, `Credit Note ${number || `#${creditNoteUID}`} auto-created from Sales Return ${returnNumber}`, "SalesReturns", {
      amount,
      sourceTransUID: transUID,
      sourceTransNumber: returnNumber,
      type: "SalesReturn",
    });
    return { creditNoteUID, creditNoteNumber: number, amount };
  }

  // createDebitNote — a refunded sales return cancelled with Recover: the customer owes the refund back
  async createDebitNote(trx: Knex.Transaction, ctx: WriteContext, customerUID: number, transUID: number, returnNumber: string, amount: number) {
    if (amount <= 0) return null;
    const { prefixUID, seq, number } = await this.numbered(trx, ctx.orgUID, "debit", todayDate(), true);
    const debitNoteUID = await this.repo.insertDebitNote(trx, {
      OrgUID: ctx.orgUID,
      PartyUID: customerUID,
      PartyType: "C",
      SourceTransUID: transUID,
      SourceTransNumber: returnNumber,
      SourceModuleUID: 106,
      DebitNoteNumber: number,
      DebitNoteToken: randomUUID(),
      DebitNoteSeq: seq,
      PrefixUID: prefixUID,
      Amount: amount,
      Status: "Pending",
      Notes: "Auto-created on SR cancellation (Recover from Customer)",
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
      IsActive: 1,
      IsDeleted: 0,
    });
    return { debitNoteUID, debitNoteNumber: number, amount };
  }

  /**
   * applyCreditNote — a Pending credit note pays an invoice: a CreditNote payment (PaymentTypeUID 0) for its whole
   * amount, and the note becomes Applied. Inside the caller's transaction; the caller recalculates the balance.
   */
  async applyCreditNote(trx: Knex.Transaction, ctx: WriteContext, creditNoteUID: number, targetTransUID: number, moduleUID = 103): Promise<{ paymentUID: number; note: Row }> {
    const note = await this.repo.creditNote(ctx.orgUID, creditNoteUID, false, trx);
    if (!note || note.Status !== "Pending") throw new CiValidationError("Credit note not found or already used.");
    const today = todayDate();
    const number = await this.payments.nextNumber(trx, ctx.orgUID, PAYMENT_IN_MODULE, today, true);
    const paymentUID = await this.repo.insertPayment(trx, {
      OrgUID: ctx.orgUID,
      BranchUID: ctx.branchUID ?? 1,
      PaymentDate: today,
      PaymentModuleUID: PAYMENT_IN_MODULE,
      PrefixUID: number.prefixUID,
      PaymentNumber: number.paymentNumber,
      UniqueNumber: number.uniqueNumber,
      TransYear: Number(today.slice(0, 4)),
      ReceiptToken: randomUUID(),
      TransUID: targetTransUID,
      ModuleUID: moduleUID,
      PartyUID: Number(note.PartyUID),
      PartyType: "C",
      PaymentTypeUID: 0,
      Amount: Number(note.Amount),
      PaymentDirection: "In",
      SourceType: "CreditNote",
      IsTransferredToCreditNote: 0,
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
    });
    await this.repo.updateCreditNote(trx, ctx.orgUID, creditNoteUID, { Status: "Applied", AppliedTransUID: targetTransUID, AppliedPaymentUID: paymentUID, UpdatedBy: ctx.userUID });
    return { paymentUID, note };
  }

  // The audit row of an applied note (after the commit)
  logApplied(ctx: WriteContext, note: Row, targetTransUID: number, paymentUID: number) {
    const number = String(note.CreditNoteNumber ?? "");
    return this.log(ctx, "APPLY_CREDIT_NOTE", Number(note.CreditNoteUID), number, `Credit Note ${number || `#${note.CreditNoteUID}`} applied to Invoice #${targetTransUID}`, "Invoices", {
      amount: Number(note.Amount),
      targetTransUID,
      paymentUID,
    });
  }

  // refundCreditNote — the organisation pays a Pending note back: Refunded, and the payments that went into it are voided
  async refund(trx: Knex.Transaction, ctx: WriteContext, creditNoteUID: number): Promise<Row> {
    const note = await this.repo.creditNote(ctx.orgUID, creditNoteUID, false, trx);
    if (!note || note.Status !== "Pending") throw new CiValidationError("Credit note not found or already used.");
    await this.repo.updateCreditNote(trx, ctx.orgUID, creditNoteUID, { Status: "Refunded", Notes: "Refunded to customer", UpdatedBy: ctx.userUID });
    await this.repo.cancelTransferredPayments(trx, ctx.orgUID, Number(note.SourceTransUID), ctx.userUID);
    return note;
  }

  log(ctx: WriteContext, action: string, entityUID: number, entityRef: string | null, summary: string, module: string, details: Record<string, unknown>) {
    return this.audit.log(ctx, { action, entityType: "CreditNote", entityUID, entityRef: entityRef ?? "", summary, module, category: "TRANSACTION", details });
  }

  // The next org-wide note sequence and its number on the note prefix (standard: from the prefix columns only)
  private async numbered(trx: Knex.Transaction, orgUID: number, table: "credit" | "debit", date: string, standard: boolean) {
    const [prefix] = await this.reads.prefixes(orgUID, table === "credit" ? CREDIT_NOTE_MODULE : DEBIT_NOTE_MODULE, undefined, trx);
    const seq = await this.repo.nextNoteSeq(trx, table, orgUID);
    const number = prefix ? buildUniqueNumber(standard ? { ...prefix, ComponentConfig: null } : prefix, seq, date) : null;
    return { prefixUID: prefix ? Number(prefix.PrefixUID) : null, seq, number };
  }
}
