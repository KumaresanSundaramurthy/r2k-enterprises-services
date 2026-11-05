import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { phpRound, smartDecimal, todayDate } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { EntryPaymentsService } from "../expense-income/entry-payments.service";
import { PaymentRecordsRepository } from "../payment-records/payment-records.repository";
import { PurchasesRepository } from "../purchases/purchases.repository";
import { DocumentEffectsService } from "../transactions/document-effects.service";
import { DocumentPaymentsService, PAYMENT_OUT_MODULE } from "../transactions/document-payments.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { PURCHASE, PURCHASE_RETURN } from "../transactions/transaction-kinds";
import { TransactionSerialsService } from "../transactions/transaction-serials.service";
import { TransactionsRepository } from "../transactions/transactions.repository";

type Row = Record<string, unknown>;

const TRANSITIONS: Record<string, string[]> = { Draft: ["Approved", "Cancelled"], Approved: ["Cancelled"], Partial: ["Cancelled"], Paid: ["Cancelled"], Cancelled: [], Rejected: [] };
const REFUND_ACTIONS = ["recover", "writeoff"];
const round = (value: number) => phpRound(value, AMOUNT_DECIMALS);
const amountOf = (form: Form, key: string) => Number(postValue(form, key, 0)) || 0;

/**
 * Purchase Returns page (CI3 Purchasereturns controller, module 108) on the shared transaction engine. A saved
 * return takes its stock out, marks its serials Returned, posts its journal and raises a vendor debit note for
 * whatever the vendor has not refunded.
 */
@Injectable()
export class PurchaseReturnsService {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly effects: DocumentEffectsService,
    private readonly payments: DocumentPaymentsService,
    private readonly serials: TransactionSerialsService,
    private readonly reads: TransactionsRepository,
    private readonly purchases: PurchasesRepository,
    private readonly paymentLookups: PaymentRecordsRepository,
    private readonly paymentFiles: EntryPaymentsService,
    private readonly audit: AuditLogService
  ) {}

  // index — the list page data plus payment types and bank accounts for the refund modal
  async getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    const [page, paymentTypes, banks] = await Promise.all([
      this.engine.pageData(PURCHASE_RETURN, orgUID, branchUID, userUID, tab, search),
      this.paymentLookups.paymentTypes(),
      this.paymentLookups.bankAccounts(orgUID),
    ]);
    return { ...page, PaymentTypes: paymentTypes, BankAccounts: banks };
  }

  // create / edit form data; edit adds the return, its lines, charges, the vendor's address, serials and files
  async getFormData(orgUID: number, langCode: string, transUID: number) {
    const basics = await this.engine.formBasics(PURCHASE_RETURN, orgUID, langCode, "list");
    if (transUID <= 0) {
      const [paymentTypes, banks] = await Promise.all([this.paymentLookups.paymentTypes(), this.paymentLookups.bankAccounts(orgUID)]);
      return { ...basics, PaymentTypes: paymentTypes, BankAccounts: banks, TransactionCharges: [], IsEditMode: false };
    }
    const ret = await this.engine.document(PURCHASE_RETURN, orgUID, transUID, langCode);
    const [items, charges, address, serials, files] = await Promise.all([
      this.engine.items(orgUID, transUID),
      this.engine.chargesOf(orgUID, transUID),
      this.engine.vendorAddress(Number(ret.PartyUID), langCode),
      this.serials.grouped(orgUID, transUID, "PurchaseReturn"),
      this.engine.attachmentsOf(orgUID, transUID),
    ]);
    return { ...basics, PRData: ret, PRItems: items, TransactionCharges: charges, VendorAddr: address, PRSerialsByProd: serials, PRAttachments: files, IsEditMode: true };
  }

  /**
   * addPurchaseReturn — a saved return marks its serials Returned and takes its stock out; after the commit its
   * journal is posted, refunds posted with it (RecordPayment = 1) are recorded and a vendor debit note is raised for
   * the amount not refunded. The vendor balance is recalculated last, so it includes that debit note.
   */
  async add(ctx: WriteContext, form: Form, files: UploadedFile[], payFiles: UploadedFile[]) {
    const vendorUID = postInt(form, "vendorSearch");
    const saved = await this.engine.create(PURCHASE_RETURN, ctx, form, PurchaseReturnsService.input(form), files, async (trx, doc) => {
      if (doc.isDraft) return;
      await this.serials.save(trx, "PurchaseReturn", ctx, doc.transUID, doc.amounts.items);
      await this.effects.saveStock(trx, PURCHASE_RETURN, ctx, doc.transUID, doc.amounts.items);
    });

    if (!saved.isDraft) {
      const { amounts, transUID, uniqueNumber } = saved;
      await this.effects.refreshLineProducts(ctx.orgUID, amounts.items);
      await this.effects.postVendorAccounts("Purchase return", ctx, [], (trx) =>
        this.effects.postPurchaseReturnJournal(trx, {
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
        })
      );

      const net = amounts.netAmount;
      let unrefunded = net;
      if (postInt(form, "RecordPayment") === 1) {
        const result = await this.payments.repo.transaction(async (trx) => {
          const rows = await this.payments.saveFormRows(trx, PURCHASE_RETURN, ctx, { transUID, partyUID: vendorUID, billTotal: net, transDate: amounts.transDate }, form, "In");
          if (rows.totalPaid > 0) {
            await this.payments.applyPaid(trx, ctx.orgUID, transUID, net, rows.totalPaid, ctx.userUID);
            await this.payments.repo.setDocStatus(trx, ctx.orgUID, transUID, net > 0 && phpRound(net - rows.totalPaid, 4) <= 0 ? "Paid" : "Partial", ctx.userUID);
          }
          return rows;
        });
        if (result.totalPaid > 0) unrefunded = Math.max(0, round(net - result.totalPaid));
        if (result.firstPaymentUID) await this.paymentFiles.saveFiles(ctx, result.firstPaymentUID, payFiles);
      }
      if (unrefunded > 0) {
        await this.payments.repo.transaction((trx) =>
          this.payments.repo.insertDebitNote(trx, {
            OrgUID: ctx.orgUID,
            PartyUID: vendorUID,
            PartyType: "S",
            SourceTransUID: transUID,
            SourceTransNumber: String(uniqueNumber ?? ""),
            SourceModuleUID: PURCHASE_RETURN.moduleUID,
            DebitNoteToken: randomUUID(),
            Amount: unrefunded,
            Status: "Pending",
            Notes: `Auto-created from Purchase Return ${uniqueNumber ?? ""}`,
            CreatedBy: ctx.userUID,
            UpdatedBy: ctx.userUID,
            IsActive: 1,
            IsDeleted: 0,
            IsCancelled: 0,
          })
        );
      }
      await this.effects.recalcVendor(ctx, vendorUID);
    }
    await this.log(ctx, "ADD_PURCHASE_RETURN", saved.transUID, saved.uniqueNumber ?? "", `Created purchase return ${saved.uniqueNumber ?? ""}`);
    return { Message: "Purchase Return created successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  /**
   * updatePurchaseReturn — a previously saved return has its stock reversed; when saved again its serials are
   * updated (or, for a re-inserted draft, saved) and its stock taken out again.
   */
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    let reversed: number[] = [];
    const saved = await this.engine.update(PURCHASE_RETURN, ctx, form, PurchaseReturnsService.input(form), files, {
      inside: async (trx, doc) => {
        if (doc.existing.DocStatus !== "Draft") reversed = await this.effects.reverseStock(trx, PURCHASE_RETURN, ctx, doc.transUID);
        if (doc.isDraft) return;
        if (doc.cloned) await this.serials.save(trx, "PurchaseReturn", ctx, doc.activeUID, doc.amounts.items);
        else await this.serials.update(trx, "PurchaseReturn", ctx, doc.activeUID, doc.amounts.items);
        await this.effects.saveStock(trx, PURCHASE_RETURN, ctx, doc.activeUID, doc.amounts.items);
      },
    });
    if (!saved.isDraft) await this.effects.refreshProducts(ctx.orgUID, [...reversed, ...saved.amounts.items.map((item) => Math.trunc(Number(item.id ?? 0) || 0))]);
    const number = saved.uniqueNumber ?? saved.previousNumber ?? "";
    await this.log(ctx, "UPDATE_PURCHASE_RETURN", saved.transUID, number, `Updated purchase return ${number}`);
    return { Message: "Purchase Return updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // deletePurchaseReturn — stock reversed; after the commit the journal is reversed and the vendor balance recalculated
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    let reversed: number[] = [];
    const existing = await this.engine.delete(PURCHASE_RETURN, ctx, transUID, async (trx) => {
      reversed = await this.effects.reverseStock(trx, PURCHASE_RETURN, ctx, transUID);
    });
    await this.effects.refreshProducts(ctx.orgUID, reversed);
    await this.effects.postVendorAccounts("Purchase return delete", ctx, [], (trx) => this.effects.reverseJournal(trx, ctx, "PurchaseReturn", transUID));
    if (Number(existing.PartyUID) > 0) await this.effects.recalcVendor(ctx, Number(existing.PartyUID));
    await this.log(ctx, "DELETE_PURCHASE_RETURN", transUID, "", `Deleted purchase return #${transUID}`);
    return { Message: "Purchase Return deleted successfully.", ...(await this.engine.listAfterChange(PURCHASE_RETURN, ctx, form)) };
  }

  // duplicatePurchaseReturn — a Draft copy dated today
  async duplicate(ctx: WriteContext, form: Form) {
    const copy = await this.engine.duplicate(PURCHASE_RETURN, ctx, postInt(form, "TransUID"), "Invalid purchase return.");
    await this.log(ctx, "DUPLICATE_PURCHASE_RETURN", copy.transUID, copy.uniqueNumber, `Duplicated purchase return as ${copy.uniqueNumber}`);
    return { Message: `Purchase Return duplicated as ${copy.uniqueNumber}.`, TransUID: copy.transUID, EditURL: `/purchasereturns/edit/${copy.transUID}` };
  }

  /**
   * updatePurchaseReturnStatus — Draft → Approved / Cancelled; Approved, Partial, Paid → Cancelled. Cancelling a
   * return the vendor already refunded needs CancelPaymentAction: without recover / writeoff the answer is
   * RequiresAction with the RefundAmount. writeoff keeps the refunds (cancelled); recover deletes them and records a
   * vendor credit note. The lines are removed, stock reversed, paid amounts reset and its Pending debit note cancelled.
   */
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = (postString(form, "Status") ?? "").trim();
    if (transUID <= 0) throw new CiValidationError("Invalid purchase return.");
    const current = await this.engine.document(PURCHASE_RETURN, ctx.orgUID, transUID);
    if (!(TRANSITIONS[String(current.DocStatus)] ?? []).includes(status)) throw new CiValidationError(`Cannot change status from ${current.DocStatus} to ${status}.`);

    const cancelling = status === "Cancelled";
    let refunded = 0;
    let action = "";
    if (cancelling) {
      refunded = await this.payments.repo.refundedTotal(ctx.orgUID, transUID);
      if (refunded > 0) {
        action = (postString(form, "CancelPaymentAction") ?? "").trim();
        if (!REFUND_ACTIONS.includes(action)) return { RequiresAction: true, RefundAmount: refunded };
      }
    }

    let reversed: number[] = [];
    const existing = await this.engine.changeStatus(PURCHASE_RETURN, ctx, transUID, status, TRANSITIONS, "Invalid purchase return.", {
      inside: async (trx, ret) => {
        if (!cancelling) return;
        await this.engine.softDeleteLines(trx, ctx, transUID);
        if (refunded > 0) await this.payments.repo.voidRefunds(trx, ctx.orgUID, transUID, action === "writeoff" ? "cancel" : "delete", ctx.userUID);
        reversed = await this.effects.reverseStock(trx, PURCHASE_RETURN, ctx, transUID);
        await this.payments.repo.setPaid(trx, ctx.orgUID, transUID, { isFullyPaid: 0, paidAmount: 0, balanceAmount: 0 }, ctx.userUID);
        if (action === "recover" && refunded > 0) {
          await this.payments.repo.insertCreditNote(trx, {
            OrgUID: ctx.orgUID,
            PartyUID: Number(ret.PartyUID),
            PartyType: "S",
            SourceTransUID: transUID,
            SourceTransNumber: String(ret.UniqueNumber ?? ""),
            SourceModuleUID: PURCHASE_RETURN.moduleUID,
            CreditNoteToken: randomUUID(),
            Amount: refunded,
            Status: "Pending",
            Notes: "Auto-created on PR cancellation (Recover — we owe vendor back)",
            CreatedBy: ctx.userUID,
            UpdatedBy: ctx.userUID,
            IsActive: 1,
            IsDeleted: 0,
          });
        }
        await this.payments.repo.cancelReturnDebitNotes(trx, ctx.orgUID, transUID, ctx.userUID);
      },
    });
    if (cancelling) await this.effects.refreshProducts(ctx.orgUID, reversed);

    const ref = existing.UniqueNumber ? `${existing.UniqueNumber} ` : "";
    const messages: Record<string, string> = { Cancelled: `Purchase return ${ref}cancelled successfully.`, Approved: `Purchase return ${ref}approved.` };
    await this.audit.log(ctx, {
      action: "UPDATE_PR_STATUS",
      entityType: "PurchaseReturn",
      entityUID: transUID,
      entityRef: String(existing.UniqueNumber ?? ""),
      summary: `Updated purchase return status to ${status}`,
      module: "PurchaseReturns",
      category: "TRANSACTION",
      details: { NewStatus: status },
    });
    return { Message: messages[status] ?? "Status updated.", NewStatus: status };
  }

  // getPRCancelDependencies — refunds already received (HasRefunds, RefundAmount)
  async cancelDependencies(orgUID: number, transUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid purchase return.");
    await this.engine.document(PURCHASE_RETURN, orgUID, transUID);
    const refunded = await this.payments.repo.refundedTotal(orgUID, transUID);
    return { HasRefunds: refunded > 0, RefundAmount: refunded };
  }

  // getVendorPurchases — the vendor's bills that still have something to return (Purchases)
  async vendorPurchases(orgUID: number, vendorUID: number) {
    if (vendorUID <= 0) throw new CiValidationError("Invalid vendor.");
    return { Purchases: await this.purchases.returnablePurchases(orgUID, vendorUID) };
  }

  // getPurchaseItems — a bill's lines with ReturnedQty / RemainingQty; fully returned lines are left out
  async purchaseItems(orgUID: number, transUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid purchase.");
    const header = await this.reads.find(orgUID, transUID, PURCHASE.moduleUID);
    if (!header) throw new CiValidationError("Purchase not found.");
    const items = await this.engine.items(orgUID, transUID);
    const returned = await this.reads.returnedQuantities(orgUID, items.map((item) => Number(item.TransProdUID)));
    const open = items
      .map((item) => {
        const returnedQty = returned.get(Number(item.TransProdUID)) ?? 0;
        return { ...item, ReturnedQty: returnedQty, RemainingQty: Math.max(0, (Number(item.Quantity) || 0) - returnedQty) };
      })
      .filter((item) => item.RemainingQty > 0);
    return { Header: header, Items: open };
  }

  /**
   * recordPayment — a refund received from the vendor against a saved return; the return row is locked and the
   * refund may not exceed what is still due. Refund files are kept with the payment.
   */
  async recordRefund(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const { orgUID, userUID } = ctx;
    const transUID = postInt(form, "TransUID");
    const paymentTypeUID = postInt(form, "PaymentTypeUID");
    const amount = amountOf(form, "Amount");
    const paymentDate = postString(form, "PaymentDate") || todayDate();
    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    if (paymentTypeUID <= 0) throw new CiValidationError("Please select a payment type.");
    if (amount <= 0) throw new CiValidationError("Amount must be greater than 0.");
    const ret = await this.engine.document(PURCHASE_RETURN, orgUID, transUID);
    if (ret.DocStatus === "Draft") throw new CiValidationError("Cannot record payment for a Draft.");
    if (["Cancelled", "Rejected"].includes(String(ret.DocStatus))) throw new CiValidationError("Purchase Return is cancelled.");
    const netAmount = Number(ret.NetAmount) || 0;

    const paymentUID = await this.payments.repo.transaction(async (trx) => {
      if (!(await this.payments.repo.lockDocument(trx, orgUID, transUID))) throw new CiValidationError("Purchase Return not found.");
      const alreadyPaid = await this.payments.repo.paidTotal(trx, orgUID, transUID);
      const pending = Math.max(0, round(netAmount - alreadyPaid));
      if (amount > pending + 0.01) throw new CiValidationError(`Amount exceeds remaining balance (${smartDecimal(pending)}). A concurrent payment may have just been recorded.`);
      const newTotalPaid = alreadyPaid + amount;
      const isFullyPaid = netAmount > 0 && phpRound(netAmount - newTotalPaid, 4) <= 0 ? 1 : 0;
      // CI3 numbers refunds on the payments-out prefix and formats the number from the prefix columns
      const number = await this.payments.nextNumber(trx, orgUID, PAYMENT_OUT_MODULE, paymentDate, true);
      const uid = await this.payments.repo.insertPayment(trx, {
        OrgUID: orgUID,
        BranchUID: ctx.branchUID ?? 1,
        PaymentDate: paymentDate,
        PaymentModuleUID: PAYMENT_OUT_MODULE,
        PrefixUID: number.prefixUID,
        PaymentNumber: number.paymentNumber,
        UniqueNumber: number.uniqueNumber,
        ReceiptToken: randomUUID(),
        TransYear: Number(paymentDate.slice(0, 4)),
        TransUID: transUID,
        ModuleUID: PURCHASE_RETURN.moduleUID,
        PartyType: "S",
        PartyUID: Number(ret.PartyUID),
        PaymentTypeUID: paymentTypeUID,
        Amount: amount,
        BankAccountUID: postInt(form, "BankAccountUID") || null,
        ReferenceNo: postString(form, "ReferenceNo") || null,
        Notes: postString(form, "Notes") || null,
        PaymentSource: "Record",
        PaymentDirection: "In",
        IsFullyPaid: isFullyPaid,
        ExcessAmount: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      await this.payments.repo.setPaid(trx, orgUID, transUID, { isFullyPaid, paidAmount: newTotalPaid, balanceAmount: Math.max(0, round(netAmount - newTotalPaid)) }, userUID);
      await this.payments.repo.setDocStatus(trx, orgUID, transUID, isFullyPaid ? "Paid" : "Partial", userUID);
      return uid;
    });
    await this.paymentFiles.saveFiles(ctx, paymentUID, files);
    await this.audit.log(ctx, {
      action: "RECORD_PR_PAYMENT",
      entityType: "PurchaseReturn",
      entityUID: transUID,
      entityRef: String(ret.UniqueNumber ?? ""),
      summary: `Recorded refund of ${amount} for purchase return ${ret.UniqueNumber ?? ""}`,
      module: "PurchaseReturns",
      category: "PAYMENT",
      details: { Amount: amount },
    });
    return { Message: `Refund of ${smartDecimal(amount)} recorded successfully.` };
  }

  // getPendingPurchases — the return's vendor's bills with a balance to pay (Purchases)
  async pendingPurchases(orgUID: number, purchaseReturnUID: number) {
    if (purchaseReturnUID <= 0) throw new CiValidationError("Invalid purchase return.");
    const ret = await this.engine.document(PURCHASE_RETURN, orgUID, purchaseReturnUID);
    return { Purchases: await this.purchases.pendingPurchases(orgUID, Number(ret.PartyUID)) };
  }

  /**
   * applyDebit — the return's unrefunded value settles part of one of the vendor's bills: a debit adjustment
   * (PaymentTypeUID 0) on the bill, and both documents' paid amounts and status move.
   */
  async applyDebit(ctx: WriteContext, form: Form) {
    const { orgUID, userUID } = ctx;
    const returnUID = postInt(form, "PurchaseReturnUID");
    const purchaseUID = postInt(form, "PurchaseUID");
    let amount = amountOf(form, "Amount");
    if (returnUID <= 0) throw new CiValidationError("Invalid purchase return.");
    if (purchaseUID <= 0) throw new CiValidationError("Please select a purchase.");
    if (amount <= 0) throw new CiValidationError("Amount must be greater than 0.");

    const ret = await this.engine.document(PURCHASE_RETURN, orgUID, returnUID);
    if (["Draft", "Cancelled", "Rejected"].includes(String(ret.DocStatus))) throw new CiValidationError("Cannot apply debit for this Purchase Return.");
    const retPaid = Number(ret.PaidAmount) || 0;
    const retNet = Number(ret.NetAmount) || 0;
    const retBalance = Math.max(0, round(retNet - retPaid));
    if (retBalance <= 0) throw new CiValidationError("No debit balance available on this Purchase Return.");

    const bill = await this.reads.find(orgUID, purchaseUID, PURCHASE.moduleUID);
    if (!bill) throw new CiValidationError("Purchase not found.");
    if (Number(bill.PartyUID) !== Number(ret.PartyUID)) throw new CiValidationError("Purchase does not belong to the same vendor.");
    if (["Draft", "Cancelled", "Paid"].includes(String(bill.DocStatus))) throw new CiValidationError("This purchase cannot receive a debit adjustment.");
    const billPaid = Number(bill.PaidAmount) || 0;
    const billNet = Number(bill.NetAmount) || 0;
    const billBalance = Math.max(0, round(billNet - billPaid));
    if (billBalance <= 0) throw new CiValidationError("Purchase has no pending balance.");
    const max = Math.min(retBalance, billBalance);
    if (amount > max + 0.01) throw new CiValidationError(`Amount exceeds available debit (${smartDecimal(max)}).`);
    amount = Math.min(amount, max);

    const today = todayDate();
    await this.payments.repo.transaction(async (trx) => {
      const number = await this.payments.nextNumber(trx, orgUID, PAYMENT_OUT_MODULE, today, true);
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
        TransUID: purchaseUID,
        ModuleUID: PURCHASE.moduleUID,
        PartyType: "S",
        PartyUID: Number(bill.PartyUID),
        PaymentTypeUID: 0,
        Amount: amount,
        BankAccountUID: null,
        ReferenceNo: ret.UniqueNumber ?? null,
        Notes: postString(form, "Notes") || null,
        PaymentSource: "Record",
        PaymentDirection: "Out",
        IsFullyPaid: 0,
        ExcessAmount: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      const billNewPaid = round(billPaid + amount);
      const billNewBalance = Math.max(0, round(billNet - billNewPaid));
      const billFullyPaid = billNet > 0 && billNewBalance <= 0 ? 1 : 0;
      await this.payments.repo.setPaid(trx, orgUID, purchaseUID, { isFullyPaid: billFullyPaid, paidAmount: billNewPaid, balanceAmount: billNewBalance }, userUID);
      await this.payments.repo.setDocStatus(trx, orgUID, purchaseUID, billFullyPaid ? "Paid" : "Partial", userUID);

      const retNewPaid = round(retPaid + amount);
      const retNewBalance = Math.max(0, round(retNet - retNewPaid));
      const retFullyPaid = retNet > 0 && retNewBalance <= 0 ? 1 : 0;
      const retStatus = retFullyPaid ? "Paid" : retNewPaid > 0 ? "Partial" : String(ret.DocStatus);
      await this.payments.repo.setPaid(trx, orgUID, returnUID, { isFullyPaid: retFullyPaid, paidAmount: retNewPaid, balanceAmount: retNewBalance }, userUID);
      if (retStatus !== ret.DocStatus) await this.payments.repo.setDocStatus(trx, orgUID, returnUID, retStatus, userUID);
    });
    return { Message: `Debit of ${smartDecimal(amount)} applied to purchase ${bill.UniqueNumber || `#${purchaseUID}`}.` };
  }

  static input(form: Form): SaveInput {
    return { partyUID: postInt(form, "vendorSearch"), validityDate: postString(form, "returnDate") || null, validityDays: null };
  }

  private log(ctx: WriteContext, action: string, entityUID: number, entityRef: string, summary: string) {
    return this.audit.log(ctx, { action, entityType: "PurchaseReturn", entityUID, entityRef, summary, module: "PurchaseReturns", category: "TRANSACTION" });
  }
}
