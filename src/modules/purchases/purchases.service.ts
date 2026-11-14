import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Knex } from "knex";
import { phpRound } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postJsonArray, postString } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { PaymentRecordsRepository } from "../payment-records/payment-records.repository";
import { PurchasePriceListRepository } from "../purchase-price-list/purchase-price-list.repository";
import { DocumentEffectsService, VendorLedgerEntry } from "../transactions/document-effects.service";
import { DocumentPaymentsService } from "../transactions/document-payments.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form, TransAmounts } from "../transactions/transaction-form";
import { PURCHASE, PURCHASE_ORDER } from "../transactions/transaction-kinds";
import { TransactionSerialsService } from "../transactions/transaction-serials.service";
import { TransactionsRepository } from "../transactions/transactions.repository";
import { PurchasesRepository } from "./purchases.repository";

type Row = Record<string, unknown>;

const TRANSITIONS: Record<string, string[]> = { Draft: ["Received"], Received: ["Paid", "Cancelled"], Paid: ["Cancelled"], Cancelled: [] };
const CANCEL_ACTIONS = ["debit_note", "refund"];

/**
 * Purchase Bills page (CI3 Purchases controller, module 105) on the shared transaction engine. A saved bill brings
 * stock in, stores serial numbers, may take payments, credits the vendor's ledger and posts its journal.
 */
@Injectable()
export class PurchasesService {
  private readonly logger = new Logger(PurchasesService.name);

  constructor(
    private readonly engine: TransactionEngineService,
    private readonly effects: DocumentEffectsService,
    private readonly payments: DocumentPaymentsService,
    private readonly serials: TransactionSerialsService,
    private readonly reads: TransactionsRepository,
    private readonly repo: PurchasesRepository,
    private readonly priceList: PurchasePriceListRepository,
    private readonly paymentLookups: PaymentRecordsRepository,
    private readonly audit: AuditLogService
  ) {}

  // index — the list page data plus payment types and bank accounts for the payment modal
  async getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    const [page, paymentTypes, banks] = await Promise.all([
      this.engine.pageData(PURCHASE, orgUID, branchUID, userUID, tab, search),
      this.paymentLookups.paymentTypes(),
      this.paymentLookups.bankAccounts(orgUID),
    ]);
    return { ...page, PaymentTypes: paymentTypes, BankAccounts: banks };
  }

  /**
   * create / edit form data. New: optionally from a purchase order (fromPurchaseOrder → POData, POItems). Edit: the
   * bill, its lines, files, serials by product, the vendor's address and charges.
   */
  async getFormData(orgUID: number, langCode: string, transUID: number, fromPurchaseOrderUID: number) {
    const [basics, paymentTypes, banks] = await Promise.all([
      this.engine.formBasics(PURCHASE, orgUID, langCode, "list"),
      this.paymentLookups.paymentTypes(),
      this.paymentLookups.bankAccounts(orgUID),
    ]);
    const lookups = { PaymentTypes: paymentTypes, BankAccounts: banks };
    if (transUID > 0) {
      const [bill, items, files, serials, charges] = await Promise.all([
        this.engine.document(PURCHASE, orgUID, transUID, langCode),
        this.engine.items(orgUID, transUID),
        this.engine.attachmentsOf(orgUID, transUID),
        this.serials.grouped(orgUID, transUID, "Purchase"),
        this.engine.chargesOf(orgUID, transUID),
      ]);
      const address = await this.engine.vendorAddress(Number(bill.PartyUID), langCode);
      return { ...basics, ...lookups, PurchData: bill, PurchItems: items, PurchAttachments: files, PurchSerialsByProd: serials, VendorAddr: address, TransactionCharges: charges, IsEditMode: true };
    }
    let order: Row | null = null;
    let orderItems: Row[] = [];
    if (fromPurchaseOrderUID > 0) {
      order = await this.engine.document(PURCHASE_ORDER, orgUID, fromPurchaseOrderUID).catch(() => null);
      if (order) orderItems = await this.engine.items(orgUID, fromPurchaseOrderUID);
    }
    return { ...basics, ...lookups, FromPOUID: fromPurchaseOrderUID, POData: order, POItems: orderItems, TransactionCharges: [], IsEditMode: false };
  }

  /**
   * addPurchase — a saved bill stores its serials, brings its stock in and may record the payments posted with it
   * (RecordPayment = 1). After the commit: the vendor's ledger (bill credited, payment debited) and journal, product
   * cache, purchase prices (UpdatePurchasePrices = 1), vendor balance and the purchase price list.
   */
  async add(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const vendorUID = postInt(form, "vendorSearch");
    let paid = 0;
    const saved = await this.engine.create(PURCHASE, ctx, form, PurchasesService.input(form), files, async (trx, doc) => {
      if (doc.isDraft) return;
      await this.serials.save(trx, "Purchase", ctx, doc.transUID, doc.amounts.items);
      await this.effects.saveStock(trx, PURCHASE, ctx, doc.transUID, doc.amounts.items);
      if (postInt(form, "RecordPayment") === 1) paid = await this.recordFormPayments(trx, ctx, form, doc.transUID, vendorUID, doc.amounts);
    });

    if (!saved.isDraft) {
      const entries: VendorLedgerEntry[] = [{ vendorUID, amount: saved.amounts.netAmount, side: "Credit", transUID: saved.transUID }];
      if (paid > 0) entries.push({ vendorUID, amount: paid, side: "Debit", transUID: saved.transUID });
      await this.effects.postVendorAccounts("Purchase", ctx, entries, (trx) => this.effects.postPurchaseJournal(trx, this.journalOf(ctx, saved.transUID, saved.uniqueNumber, saved.amounts, vendorUID)));
      await this.afterSave(ctx, form, vendorUID, saved.transUID, saved.uniqueNumber ?? "", saved.amounts, []);
    }
    await this.log(ctx, "ADD_PURCHASE", saved.transUID, saved.uniqueNumber ?? "", `Created purchase ${saved.uniqueNumber ?? ""}`);
    return { Message: "Purchase bill recorded successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  /**
   * updatePurchase — the balance follows the new amount. A previously saved bill has its stock reversed and, when
   * saved again, re-applied (serials updated in place); the old ledger credit and journal are reversed and the new
   * ones posted after the commit.
   */
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const vendorUID = postInt(form, "vendorSearch");
    let reversedProducts: number[] = [];
    const saved = await this.engine.update(PURCHASE, ctx, form, PurchasesService.input(form), files, {
      header: (existing, amounts) => ({ BalanceAmount: Math.max(0, phpRound(amounts.netAmount - (Number(existing.PaidAmount) || 0), AMOUNT_DECIMALS)) }),
      inside: async (trx, doc) => {
        if (doc.existing.DocStatus !== "Draft") reversedProducts = await this.effects.reverseStock(trx, PURCHASE, ctx, doc.transUID);
        if (doc.isDraft) return;
        if (!doc.cloned) await this.serials.update(trx, "Purchase", ctx, doc.activeUID, doc.amounts.items);
        await this.effects.saveStock(trx, PURCHASE, ctx, doc.activeUID, doc.amounts.items);
        if (postInt(form, "RecordPayment") === 1) await this.recordFormPayments(trx, ctx, form, doc.activeUID, vendorUID, doc.amounts);
      },
    });
    const existing = saved.existing;
    const number = saved.uniqueNumber ?? saved.previousNumber ?? "";

    if (!saved.isDraft) {
      const wasSaved = existing.DocStatus !== "Draft";
      const entries: VendorLedgerEntry[] = [];
      if (wasSaved) entries.push({ vendorUID: Number(existing.PartyUID), amount: Number(existing.NetAmount) || 0, side: "Debit", transUID: Number(existing.TransUID) });
      entries.push({ vendorUID, amount: saved.amounts.netAmount, side: "Credit", transUID: saved.transUID });
      await this.effects.postVendorAccounts("Purchase update", ctx, entries, async (trx) => {
        if (wasSaved) await this.effects.reverseJournal(trx, ctx, "Purchase", Number(existing.TransUID));
        await this.effects.postPurchaseJournal(trx, this.journalOf(ctx, saved.transUID, number || null, saved.amounts, vendorUID));
      });
      await this.afterSave(ctx, form, vendorUID, saved.transUID, number, saved.amounts, reversedProducts);
    }
    await this.log(ctx, "UPDATE_PURCHASE", saved.transUID, number, `Updated purchase ${number}`);
    return { Message: "Purchase bill updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  /**
   * deletePurchase — refused once a debit-note credit was applied to the bill. Its stock is reversed; payments
   * already made are deleted (refund) or cancelled into a vendor debit note (debit_note), per the posted
   * CancelPaymentAction or the organisation's setting. The unpaid part goes back off the vendor's ledger.
   */
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Purchase bill ID is required.");
    const action = await this.cancelAction(ctx.orgUID, form);
    await this.engine.document(PURCHASE, ctx.orgUID, transUID);
    if (await this.payments.repo.hasDebitNoteApplied(ctx.orgUID, transUID)) {
      throw new CiValidationError("A debit note credit has already been applied to this purchase bill. Please remove the debit note payment entry first, then delete this bill.");
    }
    const alreadyPaid = await this.paidOn(ctx.orgUID, transUID);
    const existing = await this.engine.delete(PURCHASE, ctx, transUID, async (trx, bill) => {
      await this.effects.reverseStock(trx, PURCHASE, ctx, transUID);
      await this.settlePayments(trx, ctx, bill, alreadyPaid, action);
    });
    await this.reverseAccounts(ctx, existing, alreadyPaid);
    await this.audit.log(ctx, {
      action: "DELETE_PURCHASE",
      entityType: "Purchase",
      entityUID: transUID,
      entityRef: String(existing.UniqueNumber ?? ""),
      summary: `Deleted purchase #${transUID}`,
      module: "Purchases",
      category: "TRANSACTION",
      details: { CancelPaymentAction: action },
    });
    return { Message: "Purchase bill deleted successfully.", ...(await this.engine.listAfterChange(PURCHASE, ctx, form)) };
  }

  // duplicatePurchase — a Draft copy dated today
  async duplicate(ctx: WriteContext, form: Form) {
    const copy = await this.engine.duplicate(PURCHASE, ctx, postInt(form, "TransUID"), "Invalid purchase bill.");
    await this.log(ctx, "DUPLICATE_PURCHASE", copy.transUID, copy.uniqueNumber, `Duplicated purchase ${copy.uniqueNumber}`);
    return { Message: `Purchase bill duplicated as ${copy.uniqueNumber}.`, TransUID: copy.transUID, EditURL: `/purchases/edit/${copy.transUID}` };
  }

  /**
   * updatePurchaseStatus — Draft → Received; Received → Paid / Cancelled; Paid → Cancelled. Cancelling is refused once
   * a debit-note credit was applied; it flags the bill and its lines / files cancelled (with CancelReason), reverses
   * its stock, settles payments made (refund / debit_note) and takes the unpaid part off the vendor's ledger.
   */
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = (postString(form, "Status") ?? "").trim();
    if (transUID <= 0) throw new CiValidationError("Invalid purchase bill.");
    const action = await this.cancelAction(ctx.orgUID, form);
    const reason = (postString(form, "CancelReason") ?? "").trim();
    const cancelling = status === "Cancelled";
    if (cancelling) {
      await this.engine.document(PURCHASE, ctx.orgUID, transUID);
      if (await this.payments.repo.hasDebitNoteApplied(ctx.orgUID, transUID)) {
        throw new CiValidationError("A debit note credit has already been applied to this purchase bill. Please remove the debit note payment entry first, then cancel this bill.");
      }
    }
    const existing = await this.engine.changeStatus(PURCHASE, ctx, transUID, status, TRANSITIONS, "Invalid purchase bill.", {
      ...(cancelling ? { fields: { IsCancelled: 1, CancelReason: reason || null } } : {}),
      inside: async (trx) => {
        if (!cancelling) return;
        await this.engine.cancelChildRecords(trx, ctx, transUID);
        await this.effects.reverseStock(trx, PURCHASE, ctx, transUID);
      },
    });

    let paidAtCancel: number | null = null;
    if (cancelling && existing.DocStatus !== "Draft" && Number(existing.PartyUID) > 0) {
      paidAtCancel = await this.paidOn(ctx.orgUID, transUID);
      const alreadyPaid = paidAtCancel;
      if (alreadyPaid > 0 && CANCEL_ACTIONS.includes(action)) await this.engineWrite((trx) => this.settlePayments(trx, ctx, existing, alreadyPaid, action));
      await this.reverseAccounts(ctx, existing, alreadyPaid);
    }

    const ref = existing.UniqueNumber ? `${existing.UniqueNumber} ` : "";
    const messages: Record<string, string> = {
      Cancelled: `Purchase bill ${ref}cancelled successfully.`,
      Received: `Purchase bill ${ref}marked as received.`,
      Paid: `Purchase bill ${ref}marked as paid.`,
    };
    await this.audit.log(ctx, {
      action: "UPDATE_PURCHASE_STATUS",
      entityType: "Purchase",
      entityUID: transUID,
      entityRef: String(existing.UniqueNumber ?? ""),
      summary: `Updated purchase status #${transUID}${reason ? ` — ${reason}` : ""}`,
      module: "Purchases",
      category: "TRANSACTION",
      details: { NewStatus: status, CancelPaymentAction: action, CancelReason: reason },
    });
    return {
      Message: messages[status] ?? "Status updated.",
      ...(action === "debit_note" ? { DebitNoteAmount: paidAtCancel ?? (await this.paidOn(ctx.orgUID, transUID)) } : {}),
      NewStatus: status,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  static input(form: Form): SaveInput {
    return { partyUID: postInt(form, "vendorSearch"), validityDate: postString(form, "billDueDate") || null, validityDays: null };
  }

  // The posted PaymentRows of a saved bill; the bill becomes Paid or Partial when anything was paid
  private async recordFormPayments(trx: Knex.Transaction, ctx: WriteContext, form: Form, transUID: number, vendorUID: number, amounts: TransAmounts): Promise<number> {
    const net = amounts.netAmount;
    const { totalPaid } = await this.payments.saveFormRows(trx, PURCHASE, ctx, { transUID, partyUID: vendorUID, billTotal: net, transDate: amounts.transDate }, form, "Out");
    if (totalPaid > 0) {
      await this.payments.applyPaid(trx, ctx.orgUID, transUID, net, totalPaid, ctx.userUID);
      await this.payments.repo.setDocStatus(trx, ctx.orgUID, transUID, net > 0 && phpRound(net - totalPaid, 4) <= 0 ? "Paid" : "Partial", ctx.userUID);
    }
    return totalPaid;
  }

  /**
   * After a saved bill commits: product cache (new lines and any whose stock was reversed), the product master's
   * purchase price (UpdatePurchasePrices = 1), vendor balance and the purchase price list — each on its own.
   */
  private async afterSave(ctx: WriteContext, form: Form, vendorUID: number, transUID: number, uniqueNumber: string, amounts: TransAmounts, reversedProducts: number[]): Promise<void> {
    await this.effects.refreshProducts(ctx.orgUID, [...reversedProducts, ...amounts.items.map((item) => Math.trunc(Number(item.id ?? 0) || 0))]);
    if (postInt(form, "UpdatePurchasePrices") === 1) await this.applyPriceUpdates(ctx, form);
    await this.effects.recalcVendor(ctx, vendorUID);
    try {
      await this.priceList.upsertFromPurchase(
        { orgUID: ctx.orgUID, branchUID: ctx.branchUID ?? 1, vendorUID, transUID, transDate: amounts.transDate, uniqueNumber, financialYear: String(amounts.financialYear), userUID: ctx.userUID },
        amounts.items
      );
    } catch (err) {
      this.logger.error(`Purchase price list update for ${transUID} failed: ${(err as Error).message}`);
    }
  }

  // _applyPurchasePriceUpdates — PriceChangedItems [{ productUID, newPrice }]
  private async applyPriceUpdates(ctx: WriteContext, form: Form): Promise<void> {
    try {
      for (const entry of postJsonArray<Row>(form, "PriceChangedItems")) {
        const productUID = Math.trunc(Number(entry.productUID ?? 0) || 0);
        const price = Number(entry.newPrice ?? 0) || 0;
        if (productUID <= 0 || price <= 0) continue;
        await this.repo.setProductPurchasePrice(ctx.orgUID, productUID, price, ctx.userUID);
        await this.effects.refreshProducts(ctx.orgUID, [productUID]);
      }
    } catch (err) {
      this.logger.error(`Purchase price update failed: ${(err as Error).message}`);
    }
  }

  // The posted CancelPaymentAction when debit_note / refund, else the organisation's setting
  private async cancelAction(orgUID: number, form: Form): Promise<string> {
    const posted = (postString(form, "CancelPaymentAction") ?? "").trim();
    return CANCEL_ACTIONS.includes(posted) ? posted : this.repo.purchaseCancelAction(orgUID);
  }

  // Payments made against the bill
  private async paidOn(orgUID: number, transUID: number): Promise<number> {
    return (await this.reads.payments(orgUID, transUID)).reduce((total, payment) => total + (Number(payment.Amount) || 0), 0);
  }

  /**
   * A removed / cancelled bill's payments: refund deletes them; debit_note cancels them and raises a vendor debit
   * note for the amount (Vendorbalance::createPurchaseCancelDebitNote).
   */
  private async settlePayments(trx: Knex.Transaction, ctx: WriteContext, bill: Row, alreadyPaid: number, action: string): Promise<void> {
    if (alreadyPaid <= 0 || !CANCEL_ACTIONS.includes(action)) return;
    const transUID = Number(bill.TransUID);
    if (action === "refund") {
      await this.payments.repo.voidVendorPayments(trx, ctx.orgUID, transUID, "delete", ctx.userUID);
      return;
    }
    await this.payments.repo.voidVendorPayments(trx, ctx.orgUID, transUID, "cancel", ctx.userUID);
    const number = String(bill.UniqueNumber ?? "");
    await this.payments.repo.insertDebitNote(trx, {
      OrgUID: ctx.orgUID,
      PartyUID: Number(bill.PartyUID),
      PartyType: "S",
      SourceTransUID: transUID,
      SourceTransNumber: number,
      SourceModuleUID: PURCHASE.moduleUID,
      DebitNoteToken: randomUUID(),
      Amount: alreadyPaid,
      Status: "Pending",
      Notes: `Auto-created from cancelled Purchase ${number}`,
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
      IsActive: 1,
      IsDeleted: 0,
      IsCancelled: 0,
    });
  }

  // A saved bill removed / cancelled: the unpaid part is debited back to the vendor, the journal reversed, the balance recalculated
  private async reverseAccounts(ctx: WriteContext, bill: Row, alreadyPaid: number): Promise<void> {
    const vendorUID = Number(bill.PartyUID) || 0;
    if (bill.DocStatus === "Draft" || bill.PartyType !== "S" || vendorUID <= 0) return;
    const transUID = Number(bill.TransUID);
    const remaining = Math.max(0, phpRound((Number(bill.NetAmount) || 0) - alreadyPaid, AMOUNT_DECIMALS));
    await this.effects.postVendorAccounts("Purchase reversal", ctx, remaining > 0 ? [{ vendorUID, amount: remaining, side: "Debit", transUID }] : [], (trx) =>
      this.effects.reverseJournal(trx, ctx, "Purchase", transUID)
    );
    await this.effects.recalcVendor(ctx, vendorUID);
  }

  private journalOf(ctx: WriteContext, transUID: number, uniqueNumber: string | null, amounts: TransAmounts, vendorUID: number) {
    return {
      orgUID: ctx.orgUID,
      transUID,
      number: uniqueNumber,
      date: amounts.transDate,
      financialYear: amounts.financialYear,
      netAmount: amounts.netAmount,
      taxableAmount: amounts.subTotal,
      cgst: amounts.cgstAmount,
      sgst: amounts.sgstAmount,
      igst: amounts.igstAmount,
      vendorUID,
      userUID: ctx.userUID,
    };
  }

  private engineWrite(work: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
    return this.payments.repo.transaction(work);
  }

  private log(ctx: WriteContext, action: string, entityUID: number, entityRef: string, summary: string) {
    return this.audit.log(ctx, { action, entityType: "Purchase", entityUID, entityRef, summary, module: "Purchases", category: "TRANSACTION" });
  }
}
