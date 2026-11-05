import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Knex } from "knex";
import { phpBool, phpRound, smartDecimal, todayDate } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { EntryPaymentsService } from "../expense-income/entry-payments.service";
import { SalesRepository } from "../invoices/sales.repository";
import { PaymentRecordsRepository } from "../payment-records/payment-records.repository";
import { CustomerNotesService } from "../transactions/customer-notes.service";
import { DocumentEffectsService } from "../transactions/document-effects.service";
import { DocumentPaymentsService, PAYMENT_IN_MODULE, PAYMENT_OUT_MODULE } from "../transactions/document-payments.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { INVOICE, SALES_RETURN } from "../transactions/transaction-kinds";
import { TransactionSerialsService } from "../transactions/transaction-serials.service";
import { TransactionsRepository } from "../transactions/transactions.repository";

type Row = Record<string, unknown>;

const TRANSITIONS: Record<string, string[]> = { Draft: ["Approved", "Cancelled"], Pending: ["Cancelled"], Approved: ["Cancelled"], Partial: ["Cancelled"], Issued: ["Cancelled"], Paid: ["Cancelled"], Cancelled: [], Rejected: [] };
const REFUND_ACTIONS = ["recover", "writeoff"];
const DELETABLE = ["Draft", "Approved", "Partial", "Paid"];
const round = (value: number) => phpRound(value, AMOUNT_DECIMALS);
const amountOf = (form: Form, key: string) => Number(postValue(form, key, 0)) || 0;

/**
 * Sales Returns page (CI3 Salesreturns controller, module 106) on the shared transaction engine. A saved return
 * brings stock and serials back, links the invoices its lines come from, posts its journal and raises a credit note
 * for whatever is not refunded to the customer.
 */
@Injectable()
export class SalesReturnsService {
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

  // index — the list page data plus payment types and bank accounts for the refund modal
  async getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    const [page, paymentTypes, banks] = await Promise.all([
      this.engine.pageData(SALES_RETURN, orgUID, branchUID, userUID, tab, search),
      this.paymentLookups.paymentTypes(),
      this.paymentLookups.bankAccounts(orgUID),
    ]);
    return { ...page, PaymentTypes: paymentTypes, BankAccounts: banks };
  }

  // create / edit form data; edit adds the return, its lines, charges, serials and files
  async getFormData(orgUID: number, langCode: string, transUID: number) {
    const basics = await this.engine.formBasics(SALES_RETURN, orgUID, langCode, "list");
    if (transUID <= 0) {
      const [paymentTypes, banks] = await Promise.all([this.paymentLookups.paymentTypes(), this.paymentLookups.bankAccounts(orgUID)]);
      return { ...basics, PaymentTypes: paymentTypes, BankAccounts: banks, TransactionCharges: [], IsEditMode: false };
    }
    const ret = await this.engine.document(SALES_RETURN, orgUID, transUID, langCode);
    const [items, charges, serials, files] = await Promise.all([
      this.engine.items(orgUID, transUID),
      this.engine.chargesOf(orgUID, transUID),
      this.serials.grouped(orgUID, transUID, "SalesReturn"),
      this.engine.attachmentsOf(orgUID, transUID),
    ]);
    return { ...basics, SRData: ret, SRItems: items, TransactionCharges: charges, SRSerialsByProd: serials, SRAttachments: files, IsEditMode: true };
  }

  /**
   * addSalesReturn — a saved return brings its serials and stock back and links its source invoices
   * (fromInvoiceUIDs). After the commit: its journal, refunds posted with it (RecordPayment = 1), a credit note for
   * the amount not refunded and the customer's balance.
   */
  async add(ctx: WriteContext, form: Form, files: UploadedFile[], payFiles: UploadedFile[]) {
    const customerUID = postInt(form, "customerSearch");
    const invoiceUIDs = SalesReturnsService.invoiceUIDs(form);
    const saved = await this.engine.create(SALES_RETURN, ctx, form, SalesReturnsService.input(form), files, async (trx, doc) => {
      if (doc.isDraft) return;
      await this.serials.save(trx, "SalesReturn", ctx, doc.transUID, doc.amounts.items, customerUID);
      await this.effects.saveStock(trx, SALES_RETURN, ctx, doc.transUID, doc.amounts.items);
      for (const invoiceUID of invoiceUIDs) await this.link(trx, ctx, invoiceUID, doc.transUID);
    });
    const response: Row = { Message: "Sales Return created successfully.", TransUID: saved.transUID, Token: saved.token };

    if (!saved.isDraft) {
      const { amounts, transUID, uniqueNumber } = saved;
      await this.effects.refreshLineProducts(ctx.orgUID, amounts.items);
      await this.effects.postPartyAccounts("Sales return", ctx, "Customer", [], (trx) =>
        this.effects.postSaleReturnJournal(trx, {
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
          customerUID,
          userUID: ctx.userUID,
        })
      );

      const net = amounts.netAmount;
      let creditAmount = net;
      if (postInt(form, "RecordPayment") === 1) {
        const rows = await this.payments.repo.transaction(async (trx) => {
          const result = await this.payments.saveFormRows(trx, SALES_RETURN, ctx, { transUID, partyUID: customerUID, billTotal: net, transDate: amounts.transDate }, form, "Out", { standardNumbers: true, bankBook: false });
          if (result.totalPaid > 0) {
            const fullyPaid = net > 0 && phpRound(net - result.totalPaid, 4) <= 0 ? 1 : 0;
            await this.payments.repo.setPaid(trx, ctx.orgUID, transUID, { isFullyPaid: fullyPaid, paidAmount: result.totalPaid, balanceAmount: Math.max(0, round(net - result.totalPaid)) }, ctx.userUID);
            await this.payments.repo.setDocStatus(trx, ctx.orgUID, transUID, fullyPaid ? "Paid" : "Partial", ctx.userUID);
          }
          return result;
        });
        if (rows.totalPaid > 0) creditAmount = Math.max(0, round(net - rows.totalPaid));
        if (rows.firstPaymentUID) await this.paymentFiles.saveFiles(ctx, rows.firstPaymentUID, payFiles);
      }
      if (creditAmount > 0) {
        const note = await this.notes.repo.transaction((trx) => this.notes.createSalesReturnCreditNote(trx, ctx, customerUID, transUID, String(uniqueNumber ?? ""), creditAmount, amounts.transDate));
        if (note) Object.assign(response, { CreditNoteUID: note.creditNoteUID, CreditNoteNumber: note.creditNoteNumber });
      }
      const balance = await this.effects.recalcCustomer(ctx, customerUID);
      if (balance) Object.assign(response, { CustomerBalance: balance.balance, CustomerBalanceType: balance.type });
    }
    await this.log(ctx, "ADD_SALES_RETURN", saved.transUID, saved.uniqueNumber ?? "", `Created sales return ${saved.uniqueNumber ?? ""}`);
    return response;
  }

  /**
   * updateSalesReturn — a previously saved return has its stock reversed; when saved again its serials are updated
   * (or saved, for a re-inserted draft) and stock re-applied. The invoice links follow the lines' source invoices.
   */
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    let reversed: number[] = [];
    const saved = await this.engine.update(SALES_RETURN, ctx, form, SalesReturnsService.input(form), files, {
      inside: async (trx, doc) => {
        if (doc.existing.DocStatus !== "Draft") reversed = await this.effects.reverseStock(trx, SALES_RETURN, ctx, doc.transUID);
        if (!doc.isDraft) {
          if (doc.cloned) await this.serials.save(trx, "SalesReturn", ctx, doc.activeUID, doc.amounts.items);
          else await this.serials.update(trx, "SalesReturn", ctx, doc.activeUID, doc.amounts.items);
          await this.effects.saveStock(trx, SALES_RETURN, ctx, doc.activeUID, doc.amounts.items);
        }
        const sources = await this.sales.sourceInvoiceUIDs(trx, ctx.orgUID, doc.activeUID);
        await this.sales.dropReturnLinks(trx, ctx.orgUID, doc.activeUID, sources, ctx.userUID);
        for (const invoiceUID of sources) {
          const existing = await this.sales.conversion(trx, ctx.orgUID, invoiceUID, doc.activeUID);
          if (!existing) await this.link(trx, ctx, invoiceUID, doc.activeUID);
          else if (phpBool(existing.IsDeleted)) await this.sales.restoreConversion(trx, Number(existing.ConversionUID), ctx.userUID);
        }
      },
    });
    if (!saved.isDraft) await this.effects.refreshLineProducts(ctx.orgUID, saved.amounts.items, reversed);
    const number = saved.uniqueNumber ?? saved.previousNumber ?? "";
    await this.log(ctx, "UPDATE_SALES_RETURN", saved.transUID, number, `Updated sales return ${number}`);
    return { Message: "Sales Return updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  /**
   * deleteSalesReturn — only Draft / Approved / Partial / Paid returns, and not while their credit is applied to an
   * invoice. Stock reversed, payments and the Pending credit note removed, invoice links retired; afterwards the
   * customer balance is recalculated and the journal reversed.
   */
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Sales Return ID is required.");
    const ret = await this.engine.document(SALES_RETURN, ctx.orgUID, transUID);
    if (!DELETABLE.includes(String(ret.DocStatus))) throw new CiValidationError("Only Draft, Approved, Partial, or fully paid sales returns can be deleted.");
    if ((await this.creditApplied(ctx.orgUID, ret)) > 0) {
      throw new CiValidationError("This Sales Return has already been applied to one or more invoices. Please reverse the credit allocations before deleting.");
    }
    if (await this.payments.repo.salesReturnCreditNoteApplied(ctx.orgUID, transUID)) {
      throw new CiValidationError("This Sales Return's credit note has been applied to an invoice. Please reverse the credit allocation before deleting.");
    }
    let reversed: number[] = [];
    await this.engine.delete(SALES_RETURN, ctx, transUID, async (trx, existing) => {
      reversed = await this.effects.reverseStock(trx, SALES_RETURN, ctx, transUID);
      await this.payments.repo.voidAllPayments(trx, ctx.orgUID, transUID, "delete", ctx.userUID);
      await this.reverseCreditPayments(trx, ctx, existing);
      await this.payments.repo.retireSalesReturnCreditNotes(trx, ctx.orgUID, transUID, "delete", ctx.userUID);
      await this.sales.retireConversions(trx, ctx.orgUID, transUID, "delete", ctx.userUID);
    });
    await this.effects.refreshProducts(ctx.orgUID, reversed);
    await this.effects.recalcCustomer(ctx, Number(ret.PartyUID) || 0);
    await this.effects.postPartyAccounts("Sales return delete", ctx, "Customer", [], (trx) => this.effects.reverseJournal(trx, ctx, "SalesReturn", transUID));
    await this.log(ctx, "DELETE_SALES_RETURN", transUID, String(ret.UniqueNumber ?? ""), `Deleted sales return ${ret.UniqueNumber ?? ""}`);
    return { Message: "Sales Return deleted successfully.", ...(await this.engine.listAfterChange(SALES_RETURN, ctx, form)) };
  }

  // duplicateSalesReturn — a Draft copy dated today
  async duplicate(ctx: WriteContext, form: Form) {
    const copy = await this.engine.duplicate(SALES_RETURN, ctx, postInt(form, "TransUID"), "Invalid sales return.");
    await this.log(ctx, "DUPLICATE_SALES_RETURN", copy.transUID, copy.uniqueNumber, `Duplicated sales return as ${copy.uniqueNumber}`);
    return { Message: `Sales Return duplicated as ${copy.uniqueNumber}.`, TransUID: copy.transUID, EditURL: `/salesreturns/edit/${copy.transUID}` };
  }

  /**
   * updateSalesReturnStatus — Draft → Approved / Cancelled; other saved statuses → Cancelled. Cancelling is refused
   * while the credit is applied to an invoice; a refunded return needs CancelPaymentAction (else RequiresAction with
   * the RefundAmount): writeoff keeps the refunds as cancelled, recover deletes them and raises a customer debit
   * note. Lines removed, stock reversed, paid amounts reset, the Pending credit note and invoice links cancelled.
   */
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = (postString(form, "Status") ?? "").trim();
    if (transUID <= 0) throw new CiValidationError("Invalid sales return.");
    const current = await this.engine.document(SALES_RETURN, ctx.orgUID, transUID);
    if (!(TRANSITIONS[String(current.DocStatus)] ?? []).includes(status)) throw new CiValidationError(`Cannot change status from ${current.DocStatus} to ${status}.`);
    const cancelling = status === "Cancelled";
    let refunded = 0;
    let action = "";
    if (cancelling) {
      if ((await this.creditApplied(ctx.orgUID, current)) > 0) {
        throw new CiValidationError("This Sales Return has already been applied to one or more invoices. Please reverse the credit allocations before cancelling.");
      }
      refunded = await this.payments.repo.refundedTotal(ctx.orgUID, transUID);
      if (refunded > 0) {
        action = (postString(form, "CancelPaymentAction") ?? "").trim();
        if (!REFUND_ACTIONS.includes(action)) return { RequiresAction: true, RefundAmount: refunded };
      }
    }
    let reversed: number[] = [];
    const existing = await this.engine.changeStatus(SALES_RETURN, ctx, transUID, status, TRANSITIONS, "Invalid sales return.", {
      inside: async (trx, ret) => {
        if (!cancelling) return;
        await this.engine.softDeleteLines(trx, ctx, transUID);
        if (refunded > 0) await this.payments.repo.voidRefunds(trx, ctx.orgUID, transUID, action === "writeoff" ? "cancel" : "delete", ctx.userUID);
        reversed = await this.effects.reverseStock(trx, SALES_RETURN, ctx, transUID);
        await this.payments.repo.setPaid(trx, ctx.orgUID, transUID, { isFullyPaid: 0, paidAmount: 0, balanceAmount: 0 }, ctx.userUID);
        if (action === "recover" && refunded > 0) await this.notes.createDebitNote(trx, ctx, Number(ret.PartyUID), transUID, String(ret.UniqueNumber ?? ""), refunded);
        await this.payments.repo.retireSalesReturnCreditNotes(trx, ctx.orgUID, transUID, "cancel", ctx.userUID);
        await this.sales.retireConversions(trx, ctx.orgUID, transUID, "cancel", ctx.userUID);
      },
    });
    const response: Row = {};
    if (cancelling) {
      await this.effects.refreshProducts(ctx.orgUID, reversed);
      const balance = await this.effects.recalcCustomer(ctx, Number(existing.PartyUID) || 0);
      if (balance) Object.assign(response, { CustomerBalance: balance.balance, CustomerBalanceType: balance.type });
    }
    const ref = existing.UniqueNumber ? `${existing.UniqueNumber} ` : "";
    const messages: Record<string, string> = { Cancelled: `Sales return ${ref}cancelled successfully.`, Approved: `Sales return ${ref}approved.` };
    await this.audit.log(ctx, {
      action: "UPDATE_SR_STATUS",
      entityType: "SalesReturn",
      entityUID: transUID,
      entityRef: String(existing.UniqueNumber ?? ""),
      summary: `Updated sales return status to ${status}`,
      module: "SalesReturns",
      category: "TRANSACTION",
      details: { NewStatus: status },
    });
    return { Message: messages[status] ?? "Status updated.", ...response, NewStatus: status };
  }

  // getSRCancelDependencies — credit applied to invoices and refunds received
  async cancelDependencies(orgUID: number, transUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid sales return.");
    const ret = await this.engine.document(SALES_RETURN, orgUID, transUID);
    const [credit, refunded] = await Promise.all([this.creditApplied(orgUID, ret), this.payments.repo.refundedTotal(orgUID, transUID)]);
    return { HasCreditApplied: credit > 0, CreditAmount: credit, HasRefunds: refunded > 0, RefundAmount: refunded };
  }

  // getInvoiceItems — an invoice's lines with ReturnedQty / RemainingQty (the return being edited left out)
  async invoiceItems(orgUID: number, transUID: number, excludeReturnUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid invoice.");
    const header = await this.reads.find(orgUID, transUID, INVOICE.moduleUID);
    if (!header) throw new CiValidationError("Invoice not found.");
    const items = await this.engine.items(orgUID, transUID);
    const returned = await this.reads.returnedQuantities(orgUID, items.map((item) => Number(item.TransProdUID)), excludeReturnUID);
    const open = items
      .map((item) => {
        const returnedQty = returned.get(Number(item.TransProdUID)) ?? 0;
        return { ...item, ReturnedQty: returnedQty, RemainingQty: Math.max(0, (Number(item.Quantity) || 0) - returnedQty) };
      })
      .filter((item) => item.RemainingQty > 0);
    return { Header: header, Items: open };
  }

  // getCustomerInvoices — the customer's invoices with lines still to return (Invoices)
  async customerInvoices(orgUID: number, customerUID: number, excludeReturnUID: number) {
    if (customerUID <= 0) throw new CiValidationError("Invalid customer.");
    return { Invoices: await this.sales.returnableInvoices(orgUID, customerUID, excludeReturnUID) };
  }

  // getPaymentAttachments
  async paymentAttachments(orgUID: number, transUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    return this.payments.paymentAttachments(orgUID, transUID);
  }

  /**
   * recordPayment — a refund paid to the customer against a saved return; the row is locked and the refund may not
   * exceed what is still due. The return's Pending credit note goes down by the refund.
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
    const ret = await this.engine.document(SALES_RETURN, orgUID, transUID);
    if (ret.DocStatus === "Draft") throw new CiValidationError("Cannot record payment for a Draft.");
    if (["Cancelled", "Rejected"].includes(String(ret.DocStatus))) throw new CiValidationError("Sales Return is cancelled.");
    const netAmount = Number(ret.NetAmount) || 0;
    const repo = this.payments.repo;

    const paymentUID = await repo.transaction(async (trx) => {
      if (!(await repo.lockDocument(trx, orgUID, transUID))) throw new CiValidationError("Sales Return not found.");
      const alreadyPaid = await repo.paidTotal(trx, orgUID, transUID);
      const pending = Math.max(0, round(netAmount - alreadyPaid));
      if (amount > pending + 0.01) throw new CiValidationError(`Amount exceeds remaining balance (${pending}). A concurrent payment may have just been recorded.`);
      const newTotalPaid = alreadyPaid + amount;
      const isFullyPaid = netAmount > 0 && phpRound(netAmount - newTotalPaid, 4) <= 0 ? 1 : 0;
      const number = await this.payments.nextNumber(trx, orgUID, PAYMENT_OUT_MODULE, paymentDate, true);
      const uid = await repo.insertPayment(trx, {
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
        ModuleUID: SALES_RETURN.moduleUID,
        PartyType: "C",
        PartyUID: Number(ret.PartyUID),
        PaymentTypeUID: paymentTypeUID,
        Amount: amount,
        BankAccountUID: postInt(form, "BankAccountUID") || null,
        ReferenceNo: postString(form, "ReferenceNo") || null,
        Notes: postString(form, "Notes") || null,
        PaymentSource: "Record",
        PaymentDirection: "Out",
        IsFullyPaid: isFullyPaid,
        ExcessAmount: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      await repo.setPaid(trx, orgUID, transUID, { isFullyPaid, paidAmount: newTotalPaid, balanceAmount: Math.max(0, round(netAmount - newTotalPaid)) }, userUID);
      await repo.setDocStatus(trx, orgUID, transUID, isFullyPaid ? "Paid" : "Partial", userUID);
      const note = await repo.salesReturnPendingCreditNote(trx, orgUID, transUID);
      if (note) {
        const left = round(Math.max(0, (Number(note.Amount) || 0) - amount));
        await repo.updateCreditNote(trx, orgUID, Number(note.CreditNoteUID), { Amount: left, PaymentCleared: left <= 0 ? 1 : 0, UpdatedBy: userUID });
      }
      return uid;
    });
    await this.paymentFiles.saveFiles(ctx, paymentUID, files);
    const response: Row = { Message: `Payment of ${amount} recorded successfully.` };
    const balance = await this.effects.recalcCustomer(ctx, Number(ret.PartyUID) || 0);
    if (balance) Object.assign(response, { CustomerBalance: balance.balance, CustomerBalanceType: balance.type });
    await this.audit.log(ctx, {
      action: "RECORD_SR_PAYMENT",
      entityType: "SalesReturn",
      entityUID: transUID,
      entityRef: String(ret.UniqueNumber ?? ""),
      summary: `Recorded payment of ${amount} for sales return ${ret.UniqueNumber ?? ""}`,
      module: "SalesReturns",
      category: "PAYMENT",
      details: { Amount: amount },
    });
    return response;
  }

  // getPendingInvoices — the return's customer's invoices with a balance to receive (Invoices)
  async pendingInvoices(orgUID: number, returnUID: number) {
    if (returnUID <= 0) throw new CiValidationError("Invalid sales return.");
    const ret = await this.engine.document(SALES_RETURN, orgUID, returnUID);
    return { Invoices: await this.sales.pendingInvoices(orgUID, Number(ret.PartyUID)) };
  }

  /**
   * applyCredit — the return's unrefunded value settles part of one of the customer's invoices: a credit adjustment
   * (PaymentTypeUID 0, quoting the return's number) on the invoice, and both documents' paid amounts and status move.
   */
  async applyCredit(ctx: WriteContext, form: Form) {
    const { orgUID, userUID } = ctx;
    const returnUID = postInt(form, "SalesReturnUID");
    const invoiceUID = postInt(form, "InvoiceUID");
    let amount = amountOf(form, "Amount");
    if (returnUID <= 0) throw new CiValidationError("Invalid sales return.");
    if (invoiceUID <= 0) throw new CiValidationError("Please select an invoice.");
    if (amount <= 0) throw new CiValidationError("Amount must be greater than 0.");
    const ret = await this.engine.document(SALES_RETURN, orgUID, returnUID);
    if (["Draft", "Cancelled", "Rejected"].includes(String(ret.DocStatus))) throw new CiValidationError("Cannot apply credit for this Sales Return.");
    const retPaid = Number(ret.PaidAmount) || 0;
    const retNet = Number(ret.NetAmount) || 0;
    const retBalance = Math.max(0, round(retNet - retPaid));
    if (retBalance <= 0) throw new CiValidationError("No credit balance available on this Sales Return.");
    const invoice = await this.reads.find(orgUID, invoiceUID, INVOICE.moduleUID);
    if (!invoice) throw new CiValidationError("Invoice not found.");
    if (Number(invoice.PartyUID) !== Number(ret.PartyUID)) throw new CiValidationError("Invoice does not belong to the same customer.");
    if (["Draft", "Cancelled", "Paid"].includes(String(invoice.DocStatus))) throw new CiValidationError("This invoice cannot receive a credit adjustment.");
    const invPaid = Number(invoice.PaidAmount) || 0;
    const invNet = Number(invoice.NetAmount) || 0;
    const invBalance = Math.max(0, round(invNet - invPaid));
    if (invBalance <= 0) throw new CiValidationError("Invoice has no pending balance.");
    const max = Math.min(retBalance, invBalance);
    if (amount > max + 0.01) throw new CiValidationError(`Amount exceeds available credit (${smartDecimal(max)}).`);
    amount = Math.min(amount, max);

    const today = todayDate();
    const repo = this.payments.repo;
    await repo.transaction(async (trx) => {
      const number = await this.payments.nextNumber(trx, orgUID, PAYMENT_IN_MODULE, today, true);
      await repo.insertPayment(trx, {
        OrgUID: orgUID,
        BranchUID: ctx.branchUID ?? 1,
        PaymentDate: today,
        PaymentModuleUID: PAYMENT_IN_MODULE,
        PrefixUID: number.prefixUID,
        PaymentNumber: number.paymentNumber,
        UniqueNumber: number.uniqueNumber,
        ReceiptToken: randomUUID(),
        TransYear: Number(today.slice(0, 4)),
        TransUID: invoiceUID,
        ModuleUID: INVOICE.moduleUID,
        PartyType: "C",
        PartyUID: Number(invoice.PartyUID),
        PaymentTypeUID: 0,
        Amount: amount,
        BankAccountUID: null,
        ReferenceNo: ret.UniqueNumber ?? null,
        Notes: postString(form, "Notes") || null,
        PaymentSource: "Record",
        PaymentDirection: "In",
        IsFullyPaid: 0,
        ExcessAmount: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      const invNewPaid = round(invPaid + amount);
      const invNewBalance = Math.max(0, round(invNet - invNewPaid));
      const invFull = invNet > 0 && invNewBalance <= 0 ? 1 : 0;
      await repo.setPaid(trx, orgUID, invoiceUID, { isFullyPaid: invFull, paidAmount: invNewPaid, balanceAmount: invNewBalance }, userUID);
      await repo.setDocStatus(trx, orgUID, invoiceUID, invFull ? "Paid" : "Partial", userUID);

      const retNewPaid = round(retPaid + amount);
      const retNewBalance = Math.max(0, round(retNet - retNewPaid));
      const retFull = retNet > 0 && retNewBalance <= 0 ? 1 : 0;
      const retStatus = retFull ? "Paid" : retNewPaid > 0 ? "Partial" : String(ret.DocStatus);
      await repo.setPaid(trx, orgUID, returnUID, { isFullyPaid: retFull, paidAmount: retNewPaid, balanceAmount: retNewBalance }, userUID);
      if (retStatus !== ret.DocStatus) await repo.setDocStatus(trx, orgUID, returnUID, retStatus, userUID);
    });
    return { Message: `Credit of ${smartDecimal(amount)} applied to invoice ${invoice.UniqueNumber || `#${invoiceUID}`}.` };
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  static input(form: Form): SaveInput {
    return { partyUID: postInt(form, "customerSearch"), validityDate: postString(form, "returnDate") || null, validityDays: null };
  }

  // fromInvoiceUIDs — JSON array of the source invoices
  private static invoiceUIDs(form: Form): number[] {
    const raw = postString(form, "fromInvoiceUIDs") ?? "";
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed : []).map((uid) => parseInt(String(uid), 10)).filter((uid) => uid > 0);
    } catch {
      return [];
    }
  }

  // Invoice → sales return link (InvoiceToSalesReturn)
  private link(trx: Knex.Transaction, ctx: WriteContext, invoiceUID: number, returnUID: number) {
    return this.engine.recordConversion(trx, {
      OrgUID: ctx.orgUID,
      SourceTransUID: invoiceUID,
      SourceModuleUID: INVOICE.moduleUID,
      TargetTransUID: returnUID,
      TargetModuleUID: SALES_RETURN.moduleUID,
      ConversionType: "InvoiceToSalesReturn",
      CreatedBy: ctx.userUID,
    });
  }

  // getSRCreditApplied — credit of this return applied to invoices (by its number, within the organisation)
  private async creditApplied(orgUID: number, ret: Row): Promise<number> {
    const number = String(ret.UniqueNumber ?? "");
    if (!number) return 0;
    return (await this.payments.repo.creditAppliedByNumbers(orgUID, [number])).get(number) ?? 0;
  }

  // _reverseCreditPayments — credit adjustments quoting the return are removed and their invoices' paid amounts restored
  private async reverseCreditPayments(trx: Knex.Transaction, ctx: WriteContext, ret: Row): Promise<void> {
    const number = String(ret.UniqueNumber ?? "");
    if (!number) return;
    const repo = this.payments.repo;
    for (const credit of await repo.creditPaymentsByNumber(trx, ctx.orgUID, number)) {
      await repo.updatePayment(trx, ctx.orgUID, Number(credit.PaymentUID), { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
      const invoice = await this.reads.find(ctx.orgUID, Number(credit.TransUID), INVOICE.moduleUID, "en", trx);
      if (!invoice) continue;
      const net = Number(invoice.NetAmount) || 0;
      const paid = Math.max(0, round((Number(invoice.PaidAmount) || 0) - (Number(credit.Amount) || 0)));
      const balance = Math.max(0, round(net - paid));
      await repo.setPaid(trx, ctx.orgUID, Number(credit.TransUID), { isFullyPaid: net > 0 && balance <= 0 ? 1 : 0, paidAmount: paid, balanceAmount: balance }, ctx.userUID);
      await repo.setDocStatus(trx, ctx.orgUID, Number(credit.TransUID), balance <= 0 ? "Paid" : paid > 0 ? "Partial" : "Approved", ctx.userUID);
    }
  }

  private log(ctx: WriteContext, action: string, entityUID: number, entityRef: string, summary: string) {
    return this.audit.log(ctx, { action, entityType: "SalesReturn", entityUID, entityRef, summary, module: "SalesReturns", category: "TRANSACTION" });
  }
}
