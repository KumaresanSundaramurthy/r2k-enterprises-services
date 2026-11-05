import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Knex } from "knex";
import { phpRound, smartDecimal, todayDate } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { JournalService } from "../../libraries/journal/journal.service";
import { EntryPaymentsService } from "../expense-income/entry-payments.service";
import { DocumentEffectsService } from "../transactions/document-effects.service";
import { DocumentPaymentsService, PAYMENT_OUT_MODULE } from "../transactions/document-payments.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { PURCHASE } from "../transactions/transaction-kinds";
import { TransactionsRepository } from "../transactions/transactions.repository";
import { PurchasesRepository, VendorPaymentFilter } from "./purchases.repository";

type Row = Record<string, unknown>;

const amountOf = (form: Form, key: string) => Number(postValue(form, key, 0)) || 0;
const round = (value: number) => phpRound(value, AMOUNT_DECIMALS);

/**
 * Payments and debit notes of purchase bills (CI3 Purchases::recordPurchasePayment, applyDebitNote, the Debit Notes
 * tab, payment attachments and the Purchase Payments page).
 */
@Injectable()
export class PurchasePaymentsService {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly effects: DocumentEffectsService,
    private readonly payments: DocumentPaymentsService,
    private readonly reads: TransactionsRepository,
    private readonly repo: PurchasesRepository,
    private readonly paymentFiles: EntryPaymentsService,
    private readonly journal: JournalService,
    private readonly audit: AuditLogService
  ) {}

  /**
   * recordPurchasePayment — a cash / bank payment and / or a vendor debit-note credit against a saved bill. The bill
   * row is locked so a second payment waits; the total may not exceed what is still due. The cash part debits the
   * vendor's ledger, is journalled and booked to the bank / cash book; payment files are kept with it.
   */
  async record(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const { orgUID, userUID } = ctx;
    const transUID = postInt(form, "TransUID");
    const paymentTypeUID = postInt(form, "PaymentTypeUID");
    const amount = amountOf(form, "Amount");
    const debitNoteUID = postInt(form, "DebitNoteUID");
    const debitNoteAmount = amountOf(form, "DebitNoteAmount");
    const paymentDate = postString(form, "PaymentDate") || todayDate();
    const bankAccountUID = postInt(form, "BankAccountUID") || null;
    const referenceNo = postString(form, "ReferenceNo") || null;
    const notes = postString(form, "Notes") || null;

    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    if (amount <= 0 && debitNoteAmount <= 0) throw new CiValidationError("Enter a payment amount or select a debit note.");
    if (amount > 0 && paymentTypeUID <= 0) throw new CiValidationError("Please select a payment type.");
    const bill = await this.saved(orgUID, transUID, "Cannot record payment for a Draft purchase.", "Purchase is cancelled.");

    let debitNote: Row | null = null;
    if (debitNoteUID > 0 && debitNoteAmount > 0) {
      debitNote = await this.payments.repo.vendorDebitNote(orgUID, debitNoteUID);
      if (!debitNote) throw new CiValidationError("Debit note not found.");
      if (debitNote.Status !== "Pending") throw new CiValidationError("This debit note has already been applied.");
      if (Number(debitNote.PartyUID) !== Number(bill.PartyUID)) throw new CiValidationError("Debit note does not belong to this vendor.");
      if (debitNoteAmount > Number(debitNote.Amount) + 0.01) throw new CiValidationError("Debit note amount exceeds available balance.");
    }

    const netAmount = Number(bill.NetAmount) || 0;
    const payYear = Number(paymentDate.slice(0, 4));
    const result = await this.payments.repo.transaction(async (trx) => {
      if (!(await this.payments.repo.lockDocument(trx, orgUID, transUID))) throw new CiValidationError("Purchase not found.");
      const alreadyPaid = await this.payments.repo.paidTotal(trx, orgUID, transUID);
      const pending = Math.max(0, round(netAmount - alreadyPaid));
      const effectivePaid = round(amount + debitNoteAmount);
      if (effectivePaid > pending + 0.01) throw new CiValidationError(`Total payment (${effectivePaid}) exceeds remaining balance (${pending}).`);

      const newTotalPaid = round(alreadyPaid + effectivePaid);
      const balance = Math.max(0, round(netAmount - newTotalPaid));
      const isFullyPaid = netAmount > 0 && balance <= 0 ? 1 : 0;
      const common = { OrgUID: orgUID, BranchUID: ctx.branchUID ?? 1, PaymentDate: paymentDate, TransYear: payYear, TransUID: transUID, ModuleUID: PAYMENT_OUT_MODULE, PartyType: "S", PartyUID: Number(bill.PartyUID) };
      const audited = { PaymentSource: "Record", PaymentDirection: "Out", IsFullyPaid: isFullyPaid, IsActive: 1, IsDeleted: 0, CreatedBy: userUID, UpdatedBy: userUID };

      let cashPaymentUID: number | null = null;
      if (amount > 0) {
        const number = await this.payments.nextNumber(trx, orgUID, PAYMENT_OUT_MODULE, paymentDate);
        cashPaymentUID = await this.payments.repo.insertPayment(trx, {
          ...common,
          PrefixUID: number.prefixUID,
          PaymentNumber: number.paymentNumber,
          UniqueNumber: number.uniqueNumber,
          ReceiptToken: randomUUID(),
          PaymentTypeUID: paymentTypeUID,
          Amount: amount,
          BankAccountUID: bankAccountUID,
          ReferenceNo: referenceNo,
          Notes: notes,
          ExcessAmount: Math.max(0, phpRound(newTotalPaid - netAmount, 4)),
          ...audited,
        });
      }
      if (debitNote && debitNoteAmount > 0) {
        const number = await this.payments.nextNumber(trx, orgUID, PAYMENT_OUT_MODULE, paymentDate);
        await this.payments.repo.insertPayment(trx, {
          ...common,
          PrefixUID: number.prefixUID,
          PaymentNumber: number.paymentNumber,
          UniqueNumber: number.uniqueNumber,
          ReceiptToken: randomUUID(),
          PaymentTypeUID: 0,
          Amount: debitNoteAmount,
          BankAccountUID: null,
          ReferenceNo: debitNote.SourceTransNumber ?? null,
          Notes: "Debit note credit applied",
          ExcessAmount: 0,
          ...audited,
        });
        await this.consumeDebitNote(trx, ctx, debitNote, debitNoteAmount);
      }
      await this.payments.repo.setPaid(trx, orgUID, transUID, { isFullyPaid, paidAmount: newTotalPaid, balanceAmount: balance }, userUID);
      await this.payments.repo.setDocStatus(trx, orgUID, transUID, isFullyPaid ? "Paid" : "Partial", userUID);
      return { cashPaymentUID, isFullyPaid };
    });

    if (result.cashPaymentUID) await this.paymentFiles.saveFiles(ctx, result.cashPaymentUID, files);
    const vendorUID = Number(bill.PartyUID);
    const ref = bill.UniqueNumber || `#${transUID}`;
    if (amount > 0) {
      await this.effects.postVendorAccounts("Purchase payment", ctx, [{ vendorUID, amount, side: "Debit", transUID }], (trx) =>
        this.journal.postPayment(trx, { orgUID, direction: "made", paymentUID: transUID, date: paymentDate, financialYear: payYear, amount, partyUID: vendorUID, entityType: "Vendor", userUID })
      );
      await this.journal.writeBankLedgerEntry({
        orgUID,
        bankAccountUID,
        entryType: "DR",
        amount,
        sourceType: "Purchase",
        sourceUID: transUID,
        moduleUID: PAYMENT_OUT_MODULE,
        referenceNo,
        narration: `Payment made to vendor — ${ref}`,
        entryDate: paymentDate,
        userUID,
      });
    }
    await this.effects.recalcVendor(ctx, vendorUID);

    const parts = [...(amount > 0 ? [`Payment of ${amount}`] : []), ...(debitNoteAmount > 0 ? [`Debit note credit of ${debitNoteAmount}`] : [])];
    await this.audit.log(ctx, {
      action: "RECORD_PURCHASE_PAYMENT",
      entityType: "Purchase",
      entityUID: transUID,
      entityRef: String(bill.UniqueNumber ?? ""),
      summary: `Recorded payment for purchase ${bill.UniqueNumber ?? ""}`,
      module: "Purchases",
      category: "PAYMENT",
      details: { Amount: amount, DebitNoteUID: debitNoteUID, DebitNoteAmount: debitNoteAmount },
    });
    return { Message: `${parts.join(" + ")} applied to ${ref}.`, IsFullyPaid: result.isFullyPaid, ...(await this.engine.listAfterPayment(PURCHASE, ctx, form)) };
  }

  // getVendorDebitNotes — the vendor's Pending debit notes with a balance (Data)
  async vendorDebitNotes(orgUID: number, vendorUID: number) {
    if (vendorUID <= 0) throw new CiValidationError("Invalid vendor.");
    return { Data: await this.payments.repo.availableDebitNotes(orgUID, vendorUID) };
  }

  /**
   * applyDebitNote — part or all of a vendor debit note settles a bill's balance (a PaymentTypeUID 0 payment); the
   * amount may not exceed the note's balance or the bill's.
   */
  async applyDebitNote(ctx: WriteContext, form: Form) {
    const { orgUID, userUID } = ctx;
    const transUID = postInt(form, "TransUID");
    const debitNoteUID = postInt(form, "DebitNoteUID");
    let amount = amountOf(form, "Amount");
    const notes = postString(form, "Notes") || null;
    if (transUID <= 0) throw new CiValidationError("Invalid purchase.");
    if (debitNoteUID <= 0) throw new CiValidationError("Invalid debit note.");
    if (amount <= 0) throw new CiValidationError("Amount must be greater than 0.");

    const bill = await this.reads.find(orgUID, transUID, PURCHASE.moduleUID);
    if (!bill) throw new CiValidationError("Purchase not found.");
    if (["Draft", "Cancelled", "Rejected"].includes(String(bill.DocStatus))) throw new CiValidationError("Cannot apply debit to this purchase.");
    const debitNote = await this.payments.repo.vendorDebitNote(orgUID, debitNoteUID);
    if (!debitNote) throw new CiValidationError("Debit note not found.");
    if (debitNote.Status !== "Pending") throw new CiValidationError("This debit note has already been fully applied.");
    if (Number(debitNote.PartyUID) !== Number(bill.PartyUID)) throw new CiValidationError("Debit note does not belong to the same vendor as this purchase.");

    const noteBalance = Number(debitNote.Amount) || 0;
    const billPaid = Number(bill.PaidAmount) || 0;
    const netAmount = Number(bill.NetAmount) || 0;
    const billBalance = Math.max(0, round(netAmount - billPaid));
    if (billBalance <= 0) throw new CiValidationError("Purchase has no pending balance.");
    if (noteBalance <= 0) throw new CiValidationError("Debit note has no remaining balance.");
    const max = Math.min(noteBalance, billBalance);
    if (amount > max + 0.01) throw new CiValidationError(`Amount exceeds available debit (${smartDecimal(max)}).`);
    amount = Math.min(amount, max);

    const today = todayDate();
    const isFullyPaid = await this.payments.repo.transaction(async (trx) => {
      await this.payments.repo.lockDocument(trx, orgUID, transUID);
      const number = await this.payments.nextNumber(trx, orgUID, PAYMENT_OUT_MODULE, today);
      await this.payments.repo.insertPayment(trx, {
        OrgUID: orgUID,
        BranchUID: ctx.branchUID ?? 1,
        PaymentDate: today,
        PaymentModuleUID: PAYMENT_OUT_MODULE,
        PrefixUID: number.prefixUID,
        PaymentNumber: number.paymentNumber,
        UniqueNumber: number.uniqueNumber,
        ReceiptToken: randomUUID(),
        TransYear: Number(today.slice(0, 4)),
        TransUID: transUID,
        ModuleUID: PURCHASE.moduleUID,
        PartyType: "S",
        PartyUID: Number(bill.PartyUID),
        PaymentTypeUID: 0,
        Amount: amount,
        BankAccountUID: null,
        ReferenceNo: debitNote.SourceTransNumber ?? null,
        Notes: notes,
        PaymentSource: "Record",
        PaymentDirection: "Out",
        IsFullyPaid: 0,
        ExcessAmount: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      const newPaid = round(billPaid + amount);
      const newBalance = Math.max(0, round(netAmount - newPaid));
      const fullyPaid = netAmount > 0 && newBalance <= 0 ? 1 : 0;
      await this.payments.repo.setPaid(trx, orgUID, transUID, { isFullyPaid: fullyPaid, paidAmount: newPaid, balanceAmount: newBalance }, userUID);
      await this.payments.repo.setDocStatus(trx, orgUID, transUID, fullyPaid ? "Paid" : "Partial", userUID);
      await this.consumeDebitNote(trx, ctx, debitNote, amount);
      return fullyPaid;
    });
    await this.effects.recalcVendor(ctx, Number(bill.PartyUID));
    await this.audit.log(ctx, {
      action: "APPLY_DEBIT_NOTE",
      entityType: "Purchase",
      entityUID: transUID,
      entityRef: String(bill.UniqueNumber ?? ""),
      summary: `Applied debit note #${debitNoteUID} to purchase ${bill.UniqueNumber ?? ""}`,
      module: "Purchases",
      category: "PAYMENT",
      details: { DebitNoteUID: debitNoteUID, Amount: amount },
    });
    return {
      Message: `Debit note credit of ${smartDecimal(amount)} applied to purchase ${bill.UniqueNumber || `#${transUID}`}.`,
      IsFullyPaid: isFullyPaid,
      ...(await this.engine.listAfterPayment(PURCHASE, ctx, form)),
    };
  }

  // refundDebitNote — a Pending note the vendor paid back in cash is marked Refunded
  async refundDebitNote(ctx: WriteContext, form: Form) {
    const note = await this.pendingNote(ctx.orgUID, postInt(form, "DebitNoteUID"), true, "refunded");
    await this.payments.repo.transaction((trx) => this.payments.repo.updateDebitNote(trx, ctx.orgUID, Number(note.DebitNoteUID), { Status: "Refunded", UpdatedBy: ctx.userUID }));
    await this.effects.recalcVendor(ctx, Number(note.PartyUID));
    await this.noteLog(ctx, "REFUND_DEBIT_NOTE", note, `Refunded debit note #${note.DebitNoteUID}`);
    return { Message: "Debit note marked as refunded." };
  }

  // deleteDebitNote — a Pending note is removed
  async deleteDebitNote(ctx: WriteContext, form: Form) {
    const note = await this.pendingNote(ctx.orgUID, postInt(form, "DebitNoteUID"), false, "deleted");
    await this.payments.repo.transaction((trx) => this.payments.repo.updateDebitNote(trx, ctx.orgUID, Number(note.DebitNoteUID), { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID }));
    await this.effects.recalcVendor(ctx, Number(note.PartyUID));
    await this.noteLog(ctx, "DELETE_DEBIT_NOTE", note, `Deleted debit note #${note.DebitNoteUID}`);
    return { Message: "Debit note deleted successfully." };
  }

  // getDebitNotesList — the Debit Notes tab (Data; the CI3 JS built the rows from HTML)
  async debitNotes(orgUID: number, pageNo: number, rowLimit: number, status: string, search: string) {
    const limit = Math.max(1, rowLimit || 10);
    const page = Math.max(1, pageNo || 1);
    const { total, rows } = await this.payments.repo.debitNotes(orgUID, limit, (page - 1) * limit, status.trim(), search.trim());
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit };
  }

  // getPaymentAttachments — every payment's files, each with its payment's mode, amount and number
  async paymentAttachments(orgUID: number, transUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    return this.payments.paymentAttachments(orgUID, transUID);
  }

  // getPurchasePaymentsPageDetails — payments made to vendors, with the page totals
  async paymentsPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: VendorPaymentFilter) {
    const limit = rowLimit && rowLimit > 0 ? rowLimit : 10;
    const page = Math.max(1, pageNo);
    const [rows, total, totals] = await Promise.all([
      this.repo.vendorPayments(orgUID, filter, limit, (page - 1) * limit),
      this.repo.vendorPaymentCount(orgUID, filter),
      this.repo.vendorPaymentTotals(orgUID, filter),
    ]);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit, Totals: totals };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  // A saved (not Draft / Cancelled / Rejected) bill of the organisation
  private async saved(orgUID: number, transUID: number, draftMessage: string, cancelledMessage: string): Promise<Row> {
    const bill = await this.reads.find(orgUID, transUID, PURCHASE.moduleUID);
    if (!bill) throw new CiValidationError("Purchase not found.");
    if (bill.DocStatus === "Draft") throw new CiValidationError(draftMessage);
    if (["Cancelled", "Rejected"].includes(String(bill.DocStatus))) throw new CiValidationError(cancelledMessage);
    return bill;
  }

  // The note's balance goes down by what was used; at zero it is Applied
  private async consumeDebitNote(trx: Knex.Transaction, ctx: WriteContext, note: Row, used: number): Promise<void> {
    const left = round((Number(note.Amount) || 0) - used);
    await this.payments.repo.updateDebitNote(trx, ctx.orgUID, Number(note.DebitNoteUID), { Amount: Math.max(0, left), Status: left <= 0 ? "Applied" : "Pending", UpdatedBy: ctx.userUID });
  }

  // A vendor debit note that is still Pending (refund / delete)
  private async pendingNote(orgUID: number, debitNoteUID: number, excludeCancelled: boolean, verb: string): Promise<Row> {
    if (debitNoteUID <= 0) throw new CiValidationError("Debit note ID is required.");
    const note = await this.payments.repo.debitNote(orgUID, debitNoteUID, excludeCancelled);
    // Vendor notes only: the Purchases page lists PartyType S notes (CI3 accepted a customer's note too)
    if (!note || note.PartyType !== "S") throw new CiValidationError("Debit note not found.");
    if (note.Status !== "Pending") throw new CiValidationError(`Only Pending debit notes can be ${verb}. This one is ${note.Status}.`);
    return note;
  }

  private noteLog(ctx: WriteContext, action: string, note: Row, summary: string) {
    return this.audit.log(ctx, {
      action,
      entityType: "DebitNote",
      entityUID: Number(note.DebitNoteUID),
      entityRef: String(note.SourceTransNumber ?? ""),
      summary,
      module: "Purchases",
      category: "TRANSACTION",
    });
  }
}
