import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Knex } from "knex";
import { phpRound } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postJsonArray, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { EntryPaymentsService } from "../expense-income/entry-payments.service";
import { PaymentRecordsRepository } from "../payment-records/payment-records.repository";
import { CustomerNotesService } from "../transactions/customer-notes.service";
import { DocumentEffectsService, PartyLedgerEntry } from "../transactions/document-effects.service";
import { DocumentPaymentsService } from "../transactions/document-payments.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form, TransAmounts } from "../transactions/transaction-form";
import { DELIVERY_CHALLAN, INVOICE, PROFORMA_INVOICE, QUOTATION, SALES_ORDER } from "../transactions/transaction-kinds";
import { TransactionSerialsService } from "../transactions/transaction-serials.service";
import { TransactionsRepository } from "../transactions/transactions.repository";
import { SalesRepository } from "./sales.repository";

type Row = Record<string, unknown>;

const TRANSITIONS: Record<string, string[]> = { Draft: ["Issued", "Cancelled"], Issued: ["Paid", "Partial", "Cancelled"], Partial: ["Paid", "Cancelled"], Paid: ["Cancelled"], Cancelled: [] };
const CANCEL_ACTIONS = ["credit_note", "refund", "cancel_only"];
const round = (value: number) => phpRound(value, AMOUNT_DECIMALS);

// What a saved invoice's payment-side work collected inside its transaction
interface InvoicePaid {
  paid: number;
  firstPaymentUID: number | null;
  applied: { note: Row; paymentUID: number } | null;
}

/**
 * Invoices page (CI3 Invoices controller, module 103) on the shared transaction engine. A saved invoice sells its
 * serials, takes stock out, may be paid by a credit note, form payments or on-account credit, debits the customer
 * and posts its sale journal.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly effects: DocumentEffectsService,
    private readonly payments: DocumentPaymentsService,
    private readonly notes: CustomerNotesService,
    private readonly serials: TransactionSerialsService,
    private readonly reads: TransactionsRepository,
    private readonly sales: SalesRepository,
    private readonly paymentLookups: PaymentRecordsRepository,
    private readonly paymentFiles: EntryPaymentsService,
    private readonly audit: AuditLogService
  ) {}

  // index — list page data, payment types / bank accounts; the Credit Notes tab's first page when it is the initial tab
  async getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    const [page, paymentTypes, banks] = await Promise.all([
      this.engine.pageData(INVOICE, orgUID, branchUID, userUID, tab, search),
      this.paymentLookups.paymentTypes(),
      this.paymentLookups.bankAccounts(orgUID),
    ]);
    const creditNotes = page.InitTab === "CreditNotes" ? await this.creditNotes(orgUID, 1, Number(page.RowLimit) || 10, "", search) : null;
    return { ...page, PaymentTypes: paymentTypes, BankAccounts: banks, CreditNotes: creditNotes };
  }

  /**
   * create / edit form data. Edit by TransUID or edit-link Token: the invoice, lines with returned quantities, the
   * customer's address, a draft's reserved credit note, files, charges, serials. New: pre-filled from a sales order,
   * quotation, pro forma or delivery challan.
   */
  async getFormData(orgUID: number, langCode: string, transUID: number, token: string, from: { salesOrder: number; quotation: number; proForma: number; challan: number }) {
    const uid = transUID > 0 ? transUID : await this.engine.uidByToken(INVOICE, orgUID, token);
    if (token && uid <= 0) throw new CiValidationError("Invoice not found.");
    const [basics, paymentTypes, banks] = await Promise.all([this.engine.formBasics(INVOICE, orgUID, langCode, "list"), this.paymentLookups.paymentTypes(), this.paymentLookups.bankAccounts(orgUID)]);
    const lookups = { PaymentTypes: paymentTypes, BankAccounts: banks };
    if (uid > 0) {
      const invoice = await this.engine.document(INVOICE, orgUID, uid, langCode);
      const items = await this.engine.items(orgUID, uid);
      const [returned, hasReturns, address, files, charges, serials] = await Promise.all([
        this.reads.returnedQuantities(orgUID, items.map((item) => Number(item.TransProdUID))),
        this.sales.hasSalesReturns(orgUID, uid),
        this.engine.customerAddress(Number(invoice.PartyUID), langCode),
        this.engine.attachmentsOf(orgUID, uid),
        this.engine.chargesOf(orgUID, uid),
        this.serials.grouped(orgUID, uid, "Invoice"),
      ]);
      let reservedNote: Row | null = null;
      if (invoice.DocStatus === "Draft") {
        const pending = Number((await this.sales.detailRow(orgUID, uid))?.PendingCreditNoteUID) || 0;
        if (pending > 0) reservedNote = await this.notes.repo.creditNote(orgUID, pending);
      }
      return {
        ...basics,
        ...lookups,
        InvData: invoice,
        InvItems: items,
        ReturnedQtyMap: Object.fromEntries(returned),
        HasSalesReturns: hasReturns,
        CustAddr: address,
        DraftReservedCN: reservedNote,
        InvAttachments: files,
        TransactionCharges: charges,
        InvSerialsByProd: serials,
        IsEditMode: true,
      };
    }
    const source = async (kind: typeof SALES_ORDER, sourceUID: number) => {
      if (sourceUID <= 0) return [null, []] as const;
      const doc = await this.engine.document(kind, orgUID, sourceUID).catch(() => null);
      return [doc, doc ? await this.engine.items(orgUID, sourceUID) : []] as const;
    };
    const [[so, soItems], [quote, quoteItems], [proforma, proformaItems], [challan, challanItems]] = await Promise.all([
      source(SALES_ORDER, from.salesOrder),
      source(QUOTATION, from.quotation),
      source(PROFORMA_INVOICE, from.proForma),
      source(DELIVERY_CHALLAN, from.challan),
    ]);
    return {
      ...basics,
      ...lookups,
      FromSalesOrderUID: from.salesOrder,
      SalesOrderData: so,
      SalesOrderItems: soItems,
      FromQuotationUID: from.quotation,
      QuotationData: quote,
      QuotationItems: quoteItems,
      FromProFormaUID: from.proForma,
      ProFormaData: proforma,
      ProFormaItems: proformaItems,
      FromChallanUID: from.challan,
      ChallanData: challan,
      ChallanItems: challanItems,
      TransactionCharges: [],
      IsEditMode: false,
    };
  }

  /**
   * addInvoice — a saved invoice sells its serials and takes its stock out; the selected credit note, form payments
   * (RecordPayment = 1) and on-account credits (OnAccountApplyJson) pay it, and a sales order / quotation it was
   * made from is marked Converted. After the commit: customer ledger and sale / payment journals, files, balance.
   */
  async add(ctx: WriteContext, form: Form, files: UploadedFile[], payFiles: UploadedFile[]) {
    await this.draftNoteConflict(ctx.orgUID, form);
    const customerUID = postInt(form, "customerSearch");
    let result: InvoicePaid = { paid: 0, firstPaymentUID: null, applied: null };
    const saved = await this.engine.create(INVOICE, ctx, form, InvoicesService.input(form), files, async (trx, doc) => {
      if (doc.isDraft) return;
      await this.serials.save(trx, "Invoice", ctx, doc.transUID, doc.amounts.items, customerUID);
      await this.effects.saveStock(trx, INVOICE, ctx, doc.transUID, doc.amounts.items);
      result = await this.payInvoice(trx, ctx, form, doc.transUID, customerUID, doc.amounts, true);
      await this.applyOnAccount(trx, ctx, form, doc.transUID, customerUID, doc.amounts.netAmount, result);
      await this.recordConversions(trx, ctx, form, doc.transUID);
    });
    if (!saved.isDraft) {
      await this.postAccounts(ctx, "Invoice", customerUID, saved.transUID, saved.uniqueNumber, saved.amounts, result.paid, null);
      await this.effects.refreshLineProducts(ctx.orgUID, saved.amounts.items);
    }
    await this.afterPayment(ctx, result, payFiles, saved.transUID);
    if (!saved.isDraft) await this.effects.recalcCustomer(ctx, customerUID);
    return { Message: "Invoice created successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  /**
   * updateInvoice — the balance, fully-paid flag and status follow the new amount and what was already paid; the
   * tax type cannot change once lines were returned. A saved invoice's stock is reversed and re-applied, its old
   * ledger debit and journal reversed and the new ones posted after the commit.
   */
  async update(ctx: WriteContext, form: Form, files: UploadedFile[], payFiles: UploadedFile[]) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Invoice ID is required.");
    await this.draftNoteConflict(ctx.orgUID, form);
    const customerUID = postInt(form, "customerSearch");
    await this.guardTaxType(ctx.orgUID, transUID, form);
    let result: InvoicePaid = { paid: 0, firstPaymentUID: null, applied: null };
    let reversed: number[] = [];
    const saved = await this.engine.update(INVOICE, ctx, form, InvoicesService.input(form), files, {
      header: (existing, amounts) => {
        const existingPaid = Number(existing.PaidAmount) || 0;
        const live = !amounts.isDraft && existing.DocStatus !== "Draft" && existingPaid > 0;
        const fullyPaid = live && amounts.netAmount > 0 && existingPaid >= amounts.netAmount;
        return {
          BalanceAmount: Math.max(0, round(amounts.netAmount - existingPaid)),
          IsFullyPaid: fullyPaid ? 1 : 0,
          DocStatus: live ? (fullyPaid ? "Paid" : "Partial") : amounts.isDraft ? "Draft" : "Issued",
        };
      },
      inside: async (trx, doc) => {
        if (doc.existing.DocStatus !== "Draft") reversed = await this.effects.reverseStock(trx, INVOICE, ctx, doc.transUID);
        if (doc.isDraft) return;
        await this.effects.saveStock(trx, INVOICE, ctx, doc.activeUID, doc.amounts.items);
        result = await this.payInvoice(trx, ctx, form, doc.activeUID, customerUID, doc.amounts, false);
      },
    });
    if (!saved.isDraft) {
      await this.effects.refreshLineProducts(ctx.orgUID, saved.amounts.items, reversed);
      const wasSaved = saved.existing.DocStatus !== "Draft";
      await this.postAccounts(ctx, "Invoice update", customerUID, saved.transUID, saved.uniqueNumber ?? saved.previousNumber, saved.amounts, result.paid, wasSaved ? saved.existing : null);
    }
    await this.afterPayment(ctx, result, payFiles, saved.transUID);
    await this.effects.recalcCustomer(ctx, customerUID);
    return { Message: "Invoice updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  /**
   * recordInvoicePayment — a cash payment and / or a customer's advance (overpayment of another payment) and
   * on-account credit applied to a saved invoice. The credit sources and the invoice row are locked first; the
   * total may not exceed what is still due. Only the cash part is booked to the customer's ledger, journalled and
   * entered in the bank / cash book.
   */
  async recordPayment(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const { orgUID, userUID } = ctx;
    const transUID = postInt(form, "TransUID");
    const paymentTypeUID = postInt(form, "PaymentTypeUID");
    const amount = Number(postValue(form, "Amount", 0)) || 0;
    let advanceAmount = Number(postValue(form, "AdvanceAmount", 0)) || 0;
    const advanceSourceUID = postInt(form, "ExcessSourcePaymentUID");
    let onAccountAmount = Number(postValue(form, "OnAccountAmount", 0)) || 0;
    const onAccountSourceUID = postInt(form, "OnAccountSourcePaymentUID");
    const paymentDate = postString(form, "PaymentDate") || new Date().toISOString().slice(0, 10);
    const bankAccountUID = postInt(form, "BankAccountUID") || null;
    const referenceNo = postString(form, "ReferenceNo") || null;
    const notes = postString(form, "Notes") || null;

    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    if (amount <= 0 && advanceAmount <= 0 && onAccountAmount <= 0) throw new CiValidationError("Payment amount must be greater than 0.");
    if (amount > 0 && paymentTypeUID <= 0) throw new CiValidationError("Please select a payment type.");
    if (advanceAmount > 0 && advanceSourceUID <= 0) throw new CiValidationError("Invalid advance payment source.");
    if (onAccountAmount > 0 && onAccountSourceUID <= 0) throw new CiValidationError("Invalid on-account payment source.");
    const invoice = await this.engine.document(INVOICE, orgUID, transUID);
    if (invoice.DocStatus === "Draft") throw new CiValidationError("Cannot record payment for a Draft invoice.");
    if (["Cancelled", "Rejected"].includes(String(invoice.DocStatus))) throw new CiValidationError("Invoice is cancelled.");
    const partyUID = Number(invoice.PartyUID);
    const netAmount = Number(invoice.NetAmount) || 0;
    const payYear = Number(paymentDate.slice(0, 4));

    const created = await this.payments.repo.transaction(async (trx) => {
      const repo = this.payments.repo;
      let onAccountSource: Row | null = null;
      if (onAccountAmount > 0) {
        onAccountSource = await repo.lockOnAccountSource(trx, orgUID, onAccountSourceUID, partyUID);
        if (!onAccountSource) throw new CiValidationError("On-account payment source not found.");
        const available = round(Number(onAccountSource.Amount) || 0);
        if (available <= 0) throw new CiValidationError("No on-account balance available — it may have been used by another user. Please refresh and try again.");
        onAccountAmount = round(onAccountAmount);
        if (onAccountAmount > available) throw new CiValidationError("On-account amount exceeds available balance.");
      }
      let advanceSource: Row | null = null;
      if (advanceAmount > 0) {
        advanceSource = await repo.lockAdvanceSource(trx, orgUID, advanceSourceUID, partyUID);
        if (!advanceSource) throw new CiValidationError("Advance payment source not found.");
        if (Number(advanceSource.IsDeleted) === 1) throw new CiValidationError("The advance payment source has been deleted.");
        if (Number(advanceSource.IsCancelled) === 1) throw new CiValidationError("The advance payment source has been cancelled.");
        const available = round(Number(advanceSource.ExcessAmount) || 0);
        if (available <= 0) throw new CiValidationError("No advance balance available — it may have been used by another user. Please refresh and try again.");
        advanceAmount = round(advanceAmount);
        if (advanceAmount > available) throw new CiValidationError("Advance amount exceeds available balance.");
      }
      if (!(await repo.lockDocument(trx, orgUID, transUID))) throw new CiValidationError("Invoice not found.");
      const alreadyPaid = await repo.paidTotal(trx, orgUID, transUID);
      const pending = Math.max(0, round(netAmount - alreadyPaid));
      const total = round(amount + advanceAmount + onAccountAmount);
      if (pending <= 0) throw new CiValidationError("This invoice has already been fully paid. No further payment is needed.");
      if (total > pending + 0.01) throw new CiValidationError(`Total payment (${total}) exceeds remaining balance (${pending}). A concurrent payment may have just been recorded.`);

      const newTotalPaid = round(alreadyPaid + amount + advanceAmount + onAccountAmount);
      const isFullyPaid = netAmount > 0 && phpRound(netAmount - newTotalPaid, 4) <= 0 ? 1 : 0;
      const common = { OrgUID: orgUID, BranchUID: ctx.branchUID ?? 1, PaymentDate: paymentDate, PaymentModuleUID: 110, TransYear: payYear, TransUID: transUID, ModuleUID: INVOICE.moduleUID, PartyType: "C", PartyUID: partyUID };
      const audited = { PaymentSource: "Record", PaymentDirection: "In", IsActive: 1, IsDeleted: 0, CreatedBy: userUID, UpdatedBy: userUID };
      const numbered = async () => {
        const number = await this.payments.nextNumber(trx, orgUID, 110, paymentDate);
        return { PrefixUID: number.prefixUID, PaymentNumber: number.paymentNumber, UniqueNumber: number.uniqueNumber, ReceiptToken: randomUUID() };
      };

      let cash: { uid: number; number: string | null } | null = null;
      if (amount > 0) {
        const number = await numbered();
        const uid = await repo.insertPayment(trx, {
          ...common,
          ...number,
          PaymentTypeUID: paymentTypeUID,
          Amount: amount,
          BankAccountUID: bankAccountUID,
          ReferenceNo: referenceNo,
          Notes: notes,
          IsFullyPaid: advanceAmount > 0 ? 0 : isFullyPaid,
          ExcessAmount: Math.max(0, round(amount - pending)),
          IsExcessApplied: 0,
          ExcessSourcePaymentUID: null,
          ...audited,
        });
        cash = { uid, number: number.UniqueNumber };
      }
      let advanceUID: number | null = null;
      if (advanceSource) {
        advanceUID = await repo.insertPayment(trx, {
          ...common,
          ...(await numbered()),
          PaymentTypeUID: paymentTypeUID || null,
          Amount: advanceAmount,
          Notes: `Advance credit from Payment #${advanceSourceUID}`,
          IsFullyPaid: isFullyPaid,
          ExcessAmount: 0,
          IsExcessApplied: 1,
          ExcessSourcePaymentUID: advanceSourceUID,
          ...audited,
        });
        await repo.updatePayment(trx, orgUID, advanceSourceUID, { ExcessAmount: round(Number(advanceSource.ExcessAmount) - advanceAmount), UpdatedBy: userUID });
      }
      let onAccountUID: number | null = null;
      if (onAccountSource) {
        onAccountUID = await repo.insertPayment(trx, {
          ...common,
          ...(await numbered()),
          PaymentTypeUID: paymentTypeUID || null,
          Amount: onAccountAmount,
          Notes: `On-account credit from Payment #${onAccountSourceUID}`,
          IsFullyPaid: isFullyPaid,
          ExcessAmount: 0,
          IsExcessApplied: 0,
          OnAccountSourcePaymentUID: onAccountSourceUID,
          ...audited,
        });
        await repo.updatePayment(trx, orgUID, onAccountSourceUID, { Amount: round(Number(onAccountSource.Amount) - onAccountAmount), UpdatedBy: userUID });
      }
      await repo.setPaid(trx, orgUID, transUID, { isFullyPaid, paidAmount: newTotalPaid, balanceAmount: Math.max(0, round(netAmount - newTotalPaid)) }, userUID);
      await repo.setDocStatus(trx, orgUID, transUID, isFullyPaid ? "Paid" : "Partial", userUID);
      return { cash, fileTarget: cash?.uid ?? advanceUID ?? onAccountUID, status: isFullyPaid ? "Paid" : "Partial" };
    });

    if (amount > 0) {
      await this.effects.postPartyAccounts("Invoice payment", ctx, "Customer", [{ partyUID, amount, side: "Credit", transUID }], (trx) =>
        this.effects.postPaymentJournal(trx, ctx, "received", transUID, paymentDate, payYear, amount, partyUID, "Customer")
      );
      await this.payments.writeBankEntry(ctx, {
        bankAccountUID,
        entryType: "CR",
        amount,
        sourceType: "Invoice",
        sourceUID: transUID,
        moduleUID: INVOICE.moduleUID,
        referenceNo,
        narration: `Payment received — ${created.cash?.number ?? invoice.UniqueNumber ?? `#${transUID}`}`,
        entryDate: paymentDate,
      });
    }
    const parts = [...(amount > 0 ? [`Cash ${amount}`] : []), ...(advanceAmount > 0 ? [`advance ${advanceAmount}`] : []), ...(onAccountAmount > 0 ? [`on-account ${onAccountAmount}`] : [])];
    await this.audit.log(ctx, {
      action: "RECORD_INVOICE_PAYMENT",
      entityType: "Invoice",
      entityUID: transUID,
      entityRef: String(invoice.UniqueNumber ?? ""),
      summary: `Recorded payment ₹${amount} for invoice ${invoice.UniqueNumber || `#${transUID}`}`,
      module: "Invoices",
      category: "PAYMENT",
      details: { amount, paymentStatus: created.status },
    });
    await this.effects.recalcCustomer(ctx, partyUID);
    if (created.fileTarget) await this.paymentFiles.saveFiles(ctx, created.fileTarget, files);
    return { Message: `Payment of ${parts.join(" + ") || "0"} recorded successfully.` };
  }

  /**
   * deleteInvoice — refused while an on-account credit or credit note is applied, or a sales return is raised
   * against it. Its stock is reversed; afterwards the unpaid part is credited back to the customer and the journal
   * reversed, and its payments are deleted (credit_note first turns what was paid into a credit note).
   */
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Invoice ID is required.");
    await this.engine.document(INVOICE, ctx.orgUID, transUID);
    const repo = this.payments.repo;
    if (await repo.hasOnAccountApplied(ctx.orgUID, transUID)) {
      throw new CiValidationError("This invoice has an On-Account credit applied to it. Please delete the on-account payment entry first, then delete this invoice.");
    }
    if (await repo.hasCreditNoteApplied(ctx.orgUID, transUID)) {
      throw new CiValidationError("This invoice has a Credit Note applied to it. Please remove the credit note payment entry first, then delete this invoice.");
    }
    if (await this.sales.hasSalesReturns(ctx.orgUID, transUID)) {
      throw new CiValidationError("A sales return has been raised against this invoice. Please cancel or delete the sales return first, then delete this invoice.");
    }
    let reversed: number[] = [];
    const existing = await this.engine.delete(INVOICE, ctx, transUID, async (trx) => {
      reversed = await this.effects.reverseStock(trx, INVOICE, ctx, transUID);
    });
    await this.effects.refreshProducts(ctx.orgUID, reversed);
    const customerUID = Number(existing.PartyUID) || 0;
    const isCustomer = existing.PartyType === "C";
    if (existing.DocStatus !== "Draft" && isCustomer && customerUID > 0 && (Number(existing.NetAmount) || 0) > 0) {
      const remaining = Math.max(0, round((Number(existing.NetAmount) || 0) - (await this.paidOn(ctx.orgUID, transUID))));
      await this.effects.postPartyAccounts("Invoice delete", ctx, "Customer", remaining > 0 ? [{ partyUID: customerUID, amount: remaining, side: "Credit", transUID }] : [], (trx) =>
        this.effects.reverseJournal(trx, ctx, "Invoice", transUID)
      );
    }
    if (isCustomer && customerUID > 0) {
      const action = await this.cancelAction(ctx.orgUID, form);
      await repo.transaction(async (trx) => {
        if (action === "credit_note") await this.notes.createInvoiceCreditNote(trx, ctx, customerUID, transUID, String(existing.UniqueNumber ?? ""));
        await repo.settleCustomerPayments(trx, ctx.orgUID, transUID, "delete", ctx.userUID);
      });
    }
    if (isCustomer) await this.effects.recalcCustomer(ctx, customerUID);
    return { Message: `${existing.DocStatus === "Draft" ? "Draft invoice" : "Invoice"} deleted successfully.`, ...(await this.engine.listAfterChange(INVOICE, ctx, form)) };
  }

  // duplicateInvoice — a Draft copy dated today; EditURL is its edit link
  async duplicate(ctx: WriteContext, form: Form) {
    const copy = await this.engine.duplicate(INVOICE, ctx, postInt(form, "TransUID"), "Invalid invoice.");
    return { Message: `Invoice duplicated as ${copy.uniqueNumber}.`, TransUID: copy.transUID, EditURL: `/invoices/${copy.token}/edit` };
  }

  /**
   * updateInvoiceStatus — Draft → Issued / Cancelled; Issued → Paid / Partial / Cancelled; Partial → Paid / Cancelled;
   * Paid → Cancelled. Cancelling is refused while an advance, on-account credit or credit note is involved or a sales
   * return exists; it flags the invoice and its lines / files cancelled and reverses its stock. Its payments are then
   * held on account (cancel_only), refunded (refund) or turned into a credit note (credit_note / ask).
   */
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = (postString(form, "Status") ?? "").trim();
    if (transUID <= 0) throw new CiValidationError("Invalid invoice.");
    const current = await this.engine.document(INVOICE, ctx.orgUID, transUID);
    if (!(TRANSITIONS[String(current.DocStatus)] ?? []).includes(status)) throw new CiValidationError(`Cannot change status from ${current.DocStatus} to ${status}.`);
    const cancelling = status === "Cancelled";
    const repo = this.payments.repo;
    if (cancelling) {
      if (await repo.hasExcessAppliedTo(ctx.orgUID, transUID)) {
        throw new CiValidationError(
          "This invoice has an advance payment applied to it (from a previous overpayment). Please go to the Payments module and delete that advance payment first, then cancel this invoice."
        );
      }
      if (await repo.hasExcessFrom(ctx.orgUID, transUID)) {
        throw new CiValidationError("This invoice's payment has advance credit currently applied to another invoice. Please go to the Payments module and delete that advance payment first, then cancel this invoice.");
      }
      if (await repo.hasOnAccountApplied(ctx.orgUID, transUID)) {
        throw new CiValidationError("This invoice has an On-Account credit applied to it. Please delete the on-account payment entry first, then cancel this invoice.");
      }
      if (await repo.hasCreditNoteApplied(ctx.orgUID, transUID)) {
        throw new CiValidationError("This invoice has a Credit Note applied to it. Please remove the credit note payment entry first, then cancel this invoice.");
      }
      if (await this.sales.hasSalesReturns(ctx.orgUID, transUID)) {
        throw new CiValidationError("A sales return has been raised against this invoice. Please cancel or delete the sales return first, then cancel this invoice.");
      }
    }
    const reason = (postString(form, "CancelReason") ?? "").trim();
    const postedAction = (postString(form, "CancelPaymentAction") ?? "").trim();
    let reversed: number[] = [];
    const existing = await this.engine.changeStatus(INVOICE, ctx, transUID, status, TRANSITIONS, "Invalid invoice.", {
      ...(cancelling ? { fields: { IsCancelled: 1, ...(reason ? { CancelReason: reason } : {}) } } : {}),
      inside: async (trx) => {
        if (!cancelling) return;
        await this.engine.cancelChildRecords(trx, ctx, transUID);
        reversed = await this.effects.reverseStock(trx, INVOICE, ctx, transUID);
        if (postedAction === "refund") await repo.voidAllPayments(trx, ctx.orgUID, transUID, "cancel", ctx.userUID);
      },
    });
    if (cancelling) await this.effects.refreshProducts(ctx.orgUID, reversed);
    const response: Row = { Message: `${existing.DocStatus === "Draft" ? "Draft invoice" : "Invoice"} cancelled successfully.`, NewStatus: status };

    if (cancelling && existing.PartyType === "C") {
      const customerUID = Number(existing.PartyUID);
      const action = await this.cancelAction(ctx.orgUID, form);
      const note = await repo.transaction(async (trx) => {
        if (action === "cancel_only") await repo.settleCustomerPayments(trx, ctx.orgUID, transUID, "onAccount", ctx.userUID);
        else if (action === "refund") await repo.settleCustomerPayments(trx, ctx.orgUID, transUID, "refund", ctx.userUID);
        else return this.notes.createInvoiceCreditNote(trx, ctx, customerUID, transUID, String(existing.UniqueNumber ?? ""));
        return null;
      });
      if (note) Object.assign(response, { CreditNote: note.creditNoteUID, CreditNoteAmount: note.amount, CreditNoteStatus: "Pending", ...(action === "ask" ? { NeedsDecision: true } : {}) });
      const balance = await this.effects.recalcCustomer(ctx, customerUID);
      if (balance) Object.assign(response, { CustomerBalance: balance.balance, CustomerBalanceType: balance.type });
    }
    return response;
  }

  // getPaymentAttachments
  async paymentAttachments(orgUID: number, transUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    return this.payments.paymentAttachments(orgUID, transUID);
  }

  // ── Credit notes ─────────────────────────────────────────────────────

  // applyCreditNote — a Pending note pays an invoice (Data: paymentUID)
  async applyCreditNote(ctx: WriteContext, form: Form) {
    const creditNoteUID = postInt(form, "CreditNoteUID");
    const targetUID = postInt(form, "TransUID");
    if (creditNoteUID <= 0) throw new CiValidationError("Credit note ID is required.");
    if (targetUID <= 0) throw new CiValidationError("Target invoice ID is required.");
    const applied = await this.notes.repo.transaction((trx) => this.notes.applyCreditNote(trx, ctx, creditNoteUID, targetUID));
    await this.effects.recalcCustomer(ctx, Number(applied.note.PartyUID));
    await this.notes.logApplied(ctx, applied.note, targetUID, applied.paymentUID);
    return { Message: "Credit note applied successfully.", Data: { paymentUID: applied.paymentUID } };
  }

  // refundCreditNote — a Pending note paid back to the customer
  async refundCreditNote(ctx: WriteContext, form: Form) {
    const creditNoteUID = postInt(form, "CreditNoteUID");
    if (creditNoteUID <= 0) throw new CiValidationError("Credit note ID is required.");
    const note = await this.notes.repo.transaction((trx) => this.notes.refund(trx, ctx, creditNoteUID));
    await this.effects.recalcCustomer(ctx, Number(note.PartyUID));
    const number = String(note.CreditNoteNumber ?? "");
    await this.notes.log(ctx, "REFUND_CREDIT_NOTE", creditNoteUID, number, `Credit Note ${number || `#${creditNoteUID}`} refunded to customer`, "Invoices", {
      amount: Number(note.Amount),
      sourceTransUID: Number(note.SourceTransUID),
    });
    return { Message: "Credit note marked as refunded." };
  }

  // cancelCreditNote — a Pending / Applied note goes back to Pending with its application cleared
  async cancelCreditNote(ctx: WriteContext, form: Form) {
    const creditNoteUID = postInt(form, "CreditNoteUID");
    const notes = (postString(form, "Notes") ?? "").trim();
    if (creditNoteUID <= 0) throw new CiValidationError("Invalid Credit Note.");
    const note = await this.notes.repo.creditNote(ctx.orgUID, creditNoteUID, true);
    if (!note) throw new CiValidationError("Credit Note not found.");
    if (!["Pending", "Applied"].includes(String(note.Status))) throw new CiValidationError(`Only Pending or Applied Credit Notes can be cancelled. This Credit Note is ${note.Status}.`);
    await this.notes.repo.transaction((trx) =>
      this.notes.repo.updateCreditNote(trx, ctx.orgUID, creditNoteUID, { AppliedTransUID: null, AppliedPaymentUID: null, Status: "Pending", UpdatedBy: ctx.userUID, ...(notes ? { CancelReason: notes } : {}) })
    );
    const response: Row = { Message: "Credit Note cancelled successfully." };
    const balance = await this.effects.recalcCustomer(ctx, Number(note.PartyUID) || 0);
    if (balance) Object.assign(response, { CustomerBalance: balance.balance, CustomerBalanceType: balance.type });
    const number = String(note.CreditNoteNumber ?? "");
    await this.notes.log(ctx, "CANCEL_CREDIT_NOTE", creditNoteUID, number, `Cancelled Credit Note ${number || `#${creditNoteUID}`}`, "Invoices", { amount: note.Amount, notes });
    return response;
  }

  // deleteCreditNote — a Pending note is removed
  async deleteCreditNote(ctx: WriteContext, form: Form) {
    const creditNoteUID = postInt(form, "CreditNoteUID");
    if (creditNoteUID <= 0) throw new CiValidationError("Invalid Credit Note.");
    const note = await this.notes.repo.creditNote(ctx.orgUID, creditNoteUID);
    if (!note) throw new CiValidationError("Credit Note not found.");
    if (note.Status !== "Pending") throw new CiValidationError(`Only Pending Credit Notes can be deleted. This Credit Note is ${note.Status}.`);
    await this.notes.repo.transaction((trx) => this.notes.repo.updateCreditNote(trx, ctx.orgUID, creditNoteUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID }));
    const response: Row = { Message: "Credit Note and linked payment deleted successfully." };
    const balance = await this.effects.recalcCustomer(ctx, Number(note.PartyUID) || 0);
    if (balance) Object.assign(response, { CustomerBalance: balance.balance, CustomerBalanceType: balance.type });
    const number = String(note.CreditNoteNumber ?? "");
    await this.notes.log(ctx, "DELETE_CREDIT_NOTE", creditNoteUID, number, `Deleted Credit Note ${number || `#${creditNoteUID}`} and linked payment`, "Invoices", {
      amount: note.Amount,
      sourceTransUID: Number(note.SourceTransUID),
      sourceTransNumber: note.SourceTransNumber ?? "",
    });
    return response;
  }

  // getCustomerCreditNotes — the customer's usable notes (Data)
  async customerCreditNotes(orgUID: number, customerUID: number) {
    if (customerUID <= 0) throw new CiValidationError("Customer ID is required.");
    return { Data: await this.notes.repo.pendingCreditNotes(orgUID, customerUID) };
  }

  // getCreditNotesList — the Credit Notes tab (Data; the CI3 JS built the rows from HTML)
  async creditNotes(orgUID: number, pageNo: number, rowLimit: number, status: string, search: string) {
    const limit = Math.max(1, rowLimit || 10);
    const page = Math.max(1, pageNo || 1);
    const { total, rows } = await this.notes.repo.creditNotes(orgUID, limit, (page - 1) * limit, status.trim(), search.trim());
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  static input(form: Form): SaveInput {
    const isDraft = postString(form, "action") === "draft";
    return {
      partyUID: postInt(form, "customerSearch"),
      validityDate: postString(form, "dueDate") || null,
      validityDays: null,
      extraDetail: { PendingCreditNoteUID: isDraft ? postInt(form, "CreditNoteUID") || null : null },
    };
  }

  // A draft reserving a credit note another invoice already used is refused (CreditNoteConflict)
  private async draftNoteConflict(orgUID: number, form: Form): Promise<void> {
    if (postString(form, "action") !== "draft") return;
    const creditNoteUID = postInt(form, "CreditNoteUID");
    if (creditNoteUID <= 0) return;
    const applied = await this.notes.repo.creditNoteInStatus(orgUID, creditNoteUID, "Applied");
    if (applied) throw new CiValidationError(`Credit Note ${applied.CreditNoteNumber} has already been applied to another invoice.`, { CreditNoteConflict: true });
  }

  // The tax type (inter-state) of an invoice with returned lines stays as it is
  private async guardTaxType(orgUID: number, transUID: number, form: Form): Promise<void> {
    const posted = postValue(form, "isInterState");
    if (posted === null || posted === undefined || posted === "") return;
    const current = Number((await this.sales.detailRow(orgUID, transUID))?.IsInterState ?? 0) || 0;
    if ((parseInt(String(posted), 10) || 0) !== current && (await this.sales.hasSalesReturns(orgUID, transUID))) {
      throw new CiValidationError("Tax type cannot be changed — this invoice has items that have been returned.");
    }
  }

  /**
   * The credit note (CreditNoteUID) and form payments (RecordPayment = 1) paying a saved invoice, inside its
   * transaction. A note another invoice already used is refused; on update a note already applied here is skipped.
   */
  private async payInvoice(trx: Knex.Transaction, ctx: WriteContext, form: Form, transUID: number, customerUID: number, amounts: TransAmounts, isNew: boolean): Promise<InvoicePaid> {
    const result: InvoicePaid = { paid: 0, firstPaymentUID: null, applied: null };
    const net = amounts.netAmount;
    const creditNoteUID = postInt(form, "CreditNoteUID");
    if (creditNoteUID > 0 && (isNew || !(await this.notes.repo.creditNoteAppliedTo(ctx.orgUID, creditNoteUID, transUID, trx)))) {
      const pending = await this.notes.repo.creditNoteInStatus(ctx.orgUID, creditNoteUID, "Pending", trx);
      if (pending) {
        const applied = await this.notes.applyCreditNote(trx, ctx, creditNoteUID, transUID);
        result.applied = applied;
        result.paid += round(Number(pending.Amount) || 0);
        await this.payments.applyPaid(trx, ctx.orgUID, transUID, net, result.paid, ctx.userUID);
      } else {
        const used = await this.notes.repo.creditNoteInStatus(ctx.orgUID, creditNoteUID, "Applied", trx);
        if (used) throw new CiValidationError(`Credit Note ${used.CreditNoteNumber} has already been applied to another invoice. Please remove it and save again.`);
      }
    }
    if (postInt(form, "RecordPayment") === 1) {
      const rows = await this.payments.saveFormRows(trx, INVOICE, ctx, { transUID, partyUID: customerUID, billTotal: net, transDate: amounts.transDate }, form, "In");
      result.firstPaymentUID = rows.firstPaymentUID;
      if (rows.totalPaid > 0) {
        result.paid += rows.totalPaid;
        await this.payments.applyPaid(trx, ctx.orgUID, transUID, net, result.paid, ctx.userUID);
      }
    }
    return result;
  }

  /**
   * OnAccountApplyJson [{ PaymentUID, ApplyAmount }] — the customer's on-account payments pay the new invoice: an
   * OnAccount payment per source, and the source is used up or reduced. Only the customer's own on-account payments
   * are taken (CI3 accepted any).
   */
  private async applyOnAccount(trx: Knex.Transaction, ctx: WriteContext, form: Form, transUID: number, customerUID: number, net: number, result: InvoicePaid): Promise<void> {
    const repo = this.payments.repo;
    let applied = 0;
    for (const item of postJsonArray<Row>(form, "OnAccountApplyJson")) {
      const sourceUID = Math.trunc(Number(item.PaymentUID ?? 0) || 0);
      let applyAmount = round(Number(item.ApplyAmount ?? 0) || 0);
      if (sourceUID <= 0 || applyAmount <= 0) continue;
      const source = await repo.onAccountPayment(trx, ctx.orgUID, sourceUID);
      if (!source || Number(source.PartyUID) !== customerUID) continue;
      const sourceAmount = round(Number(source.Amount) || 0);
      applyAmount = Math.min(applyAmount, sourceAmount);
      await repo.insertPayment(trx, {
        OrgUID: ctx.orgUID,
        BranchUID: ctx.branchUID ?? 1,
        TransUID: transUID,
        PartyUID: customerUID,
        PartyType: "C",
        PaymentDirection: "In",
        Amount: applyAmount,
        SourceType: "OnAccount",
        IsOnAccount: 0,
        OnAccountSourcePaymentUID: sourceUID,
        IsTransferredToCreditNote: 0,
        IsCancelled: 0,
        IsDeleted: 0,
        IsActive: 1,
        CreatedBy: ctx.userUID,
        UpdatedBy: ctx.userUID,
      });
      await repo.updatePayment(trx, ctx.orgUID, sourceUID, applyAmount >= sourceAmount ? { OnAccountAppliedTransUID: transUID, UpdatedBy: ctx.userUID } : { Amount: round(sourceAmount - applyAmount), UpdatedBy: ctx.userUID });
      applied += applyAmount;
    }
    if (applied > 0) {
      await this.payments.applyPaid(trx, ctx.orgUID, transUID, net, result.paid + applied, ctx.userUID);
      result.paid += applied;
    }
  }

  // A saved invoice made from a sales order / quotation marks it Converted and records the link
  private async recordConversions(trx: Knex.Transaction, ctx: WriteContext, form: Form, transUID: number): Promise<void> {
    for (const [postKey, source, type] of [
      ["fromSalesOrderUID", SALES_ORDER, "OrderToInvoice"],
      ["fromQuotationUID", QUOTATION, "QuotToInvoice"],
    ] as const) {
      const sourceUID = postInt(form, postKey);
      if (sourceUID <= 0) continue;
      await this.engine.setStatus(trx, ctx.orgUID, sourceUID, "Converted", ctx.userUID);
      await this.engine.recordConversion(trx, { OrgUID: ctx.orgUID, SourceTransUID: sourceUID, SourceModuleUID: source.moduleUID, TargetTransUID: transUID, TargetModuleUID: INVOICE.moduleUID, ConversionType: type, CreatedBy: ctx.userUID });
    }
  }

  /**
   * The customer ledger (invoice debited, what was paid credited) and the sale / payment journals; on update the
   * previous amount is credited back and the old journal reversed first.
   */
  private async postAccounts(ctx: WriteContext, label: string, customerUID: number, transUID: number, number: string | null, amounts: TransAmounts, paid: number, previous: Row | null) {
    const entries: PartyLedgerEntry[] = [];
    if (previous) entries.push({ partyUID: customerUID, amount: Number(previous.NetAmount) || 0, side: "Credit", transUID });
    entries.push({ partyUID: customerUID, amount: amounts.netAmount, side: "Debit", transUID });
    if (paid > 0) entries.push({ partyUID: customerUID, amount: paid, side: "Credit", transUID });
    await this.effects.postPartyAccounts(label, ctx, "Customer", entries, async (trx) => {
      if (previous) await this.effects.reverseJournal(trx, ctx, "Invoice", Number(previous.TransUID));
      await this.effects.postSaleJournal(trx, {
        orgUID: ctx.orgUID,
        transUID,
        number,
        date: amounts.transDate,
        financialYear: amounts.financialYear,
        netAmount: amounts.netAmount,
        taxableAmount: amounts.subTotal,
        cgst: amounts.cgstAmount,
        sgst: amounts.sgstAmount,
        igst: amounts.igstAmount,
        customerUID,
        userUID: ctx.userUID,
      });
      if (paid > 0) await this.effects.postPaymentJournal(trx, ctx, "received", transUID, amounts.transDate, amounts.financialYear, paid, customerUID, "Customer");
    });
  }

  // After the commit: the applied note's audit row and the first form payment's files
  private async afterPayment(ctx: WriteContext, result: InvoicePaid, payFiles: UploadedFile[], transUID: number): Promise<void> {
    if (result.applied) await this.notes.logApplied(ctx, result.applied.note, transUID, result.applied.paymentUID);
    if (result.firstPaymentUID) await this.paymentFiles.saveFiles(ctx, result.firstPaymentUID, payFiles);
  }

  // The posted CancelPaymentAction when one of credit_note / refund / cancel_only, else the organisation's setting
  private async cancelAction(orgUID: number, form: Form): Promise<string> {
    const posted = (postString(form, "CancelPaymentAction") ?? "").trim();
    return CANCEL_ACTIONS.includes(posted) ? posted : this.sales.invoiceCancelAction(orgUID);
  }

  private async paidOn(orgUID: number, transUID: number): Promise<number> {
    return (await this.reads.payments(orgUID, transUID)).reduce((total, payment) => total + (Number(payment.Amount) || 0), 0);
  }
}
