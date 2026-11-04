import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { phpBool, phpRound, smartDecimal, todayDate } from "../../common/utils/php-compat";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postJsonArray, postString, postValue } from "../../core/utils/form-values";
import { EntryAttachmentsService, UploadedFile } from "../expense-income/entry-attachments.service";
import { EXPENSE_CATEGORIES } from "../expense-income/entry-categories.service";
import { AMOUNT_DECIMALS, EXPENSE } from "../expense-income/entry-kind";
import { RecordedPayment } from "../expense-income/entry-payments.service";
import { EntryConfig, EntryRecordService, EntryToolkit, Form, Row } from "../expense-income/entry-record.service";
import { VendorCacheService } from "../vendors/vendor-cache.service";
import { ExpensesRepository } from "./expenses.repository";

const round = (value: unknown) => phpRound(Number(value) || 0, AMOUNT_DECIMALS);
const AMOUNT_TYPES = ["NetAmount", "TotalAmount"];

const CONFIG: EntryConfig = {
  kind: EXPENSE,
  categories: EXPENSE_CATEGORIES,
  uidField: "ExpenseUID",
  bulkField: "ExpenseUIDs",
  settledStatus: "Paid",
  datePreference: "df_expenses",
  audit: { entity: "Expense", module: "Expenses", action: "EXPENSE", noun: "expense" },
  text: {
    invalid: "Invalid expense record.",
    notFound: "Expense not found.",
    cancelledNoDelete: "Cancelled expenses cannot be deleted.",
    deleted: "Expense deleted.",
    paymentNotAllowed: "Payment can only be recorded for Pending or Partially Paid expenses.",
    overpaid: (total, net) => `Total payments (${total}) cannot exceed the expense amount (${net}).`,
    settled: "Expense marked as paid.",
    bulkNoun: "expense(s)",
    paymentNarration: (full, number) => `${full ? "Expense paid" : "Expense partially paid"} — ${number}`,
    settledNarration: (number) => `Expense paid — ${number}`,
  },
};

// One posted line of the with-tax form (Items JSON)
interface ItemInput {
  ExpItemUID?: unknown;
  CategoryUID?: unknown;
  ItemDescription?: unknown;
  Amount?: unknown;
  TaxPercentage?: unknown;
  TaxAmount?: unknown;
  CGSTAmount?: unknown;
  SGSTAmount?: unknown;
  IGSTAmount?: unknown;
  TotalAmount?: unknown;
}

/**
 * Expenses page (CI3 Expenses controller). Without tax an expense is one amount; with tax it has line items
 * (with GST split) and a vendor. TDS is deducted from the total, RCM and round-off are stored with it, and the
 * journal debits the expense and input tax and credits the vendor (or Accounts Payable).
 */
@Injectable()
export class ExpensesService extends EntryRecordService {
  constructor(
    tk: EntryToolkit,
    private readonly repo: ExpensesRepository,
    private readonly attachments: EntryAttachmentsService,
    private readonly vendorCache: VendorCacheService
  ) {
    super(tk, repo, CONFIG);
  }

  // getPageDetails sends ShowStats = 1 when the stat cards are shown
  protected async statsWanted(_orgUID: number, form: Form): Promise<boolean> {
    return postInt(form, "ShowStats") === 1;
  }

  // openCreate / openEdit — dropdowns, and for an edit the expense, its lines, attachments and the vendor's state
  async getFormData(orgUID: number, expenseUID: number) {
    const { lookups, categories } = this.tk;
    const [categoryList, paymentTypes, bankAccounts] = await Promise.all([categories.dropdown(EXPENSE_CATEGORIES, orgUID), lookups.paymentTypes(), lookups.bankAccounts(orgUID)]);
    const base = { Categories: categoryList, PaymentTypes: paymentTypes, BankAccounts: bankAccounts };
    if (expenseUID <= 0) return { ...base, ExpenseData: null, ExpenseItems: [], ExpenseAttachments: [], VendorStateCode: "" };

    const expense = await this.liveRecord(orgUID, expenseUID);
    const vendorUID = Number(expense.VendorUID) || 0;
    const [items, files, vendorState] = await Promise.all([
      this.repo.items(orgUID, expenseUID),
      lookups.attachments(orgUID, EXPENSE.sourceType, expenseUID),
      vendorUID > 0 ? this.repo.vendorBillingState(orgUID, vendorUID) : Promise.resolve(""),
    ]);
    return { ...base, ExpenseData: expense, ExpenseItems: items, ExpenseAttachments: files, VendorStateCode: vendorState };
  }

  // getExpenseDetail
  async getDetail(orgUID: number, expenseUID: number) {
    const expense = await this.liveRecord(orgUID, expenseUID);
    return { Data: expense, Items: await this.repo.items(orgUID, expenseUID) };
  }

  // getTdsSections
  async getTdsSections() {
    return { Data: await this.repo.tdsSections() };
  }

  // addExpense — the expense, EXP-{id} number, the payment when IsPaid, the lines; then journal, vendor cache, files
  async create(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const data = ExpensesService.buildData(form, true);
    const created = await this.tk.db.write.transaction(async (trx) => {
      const expenseUID = await this.repo.insert(trx, { ...data, OrgUID: ctx.orgUID, BranchUID: ctx.branchUID ?? 1, ModuleUID: EXPENSE.moduleUID, CreatedBy: ctx.userUID, UpdatedBy: ctx.userUID });
      const expenseNumber = `EXP-${String(expenseUID).padStart(4, "0")}`;
      await this.repo.setNumber(trx, ctx.orgUID, expenseUID, expenseNumber);
      const record = { ExpenseUID: expenseUID, ExpenseNumber: expenseNumber, ExpenseDate: data.ExpenseDate };
      const payment = data.IsPaid ? await this.settlePayment(trx, ctx, form, record, data.NetAmount) : null;
      await this.saveItems(trx, ctx, form, expenseUID);
      return { expenseUID, expenseNumber, payment };
    });
    const { expenseUID, expenseNumber, payment } = created;
    const vendorUID = Number(data.VendorUID) || 0;

    await this.tk.journal.postAfterSave(`Expense ${expenseUID}`, async (trx) => {
      await this.tk.journal.postExpense(trx, this.journalOf(ctx, expenseUID, expenseNumber, data));
      if (payment && vendorUID > 0) await this.postVendorPayment(trx, ctx, payment, data.NetAmount, vendorUID);
    });
    if (vendorUID > 0) await this.vendorCache.refresh(ctx.orgUID, vendorUID);
    await this.attachments.save(ctx, EXPENSE, expenseUID, files);
    await this.log(ctx, "ADD", { ExpenseUID: expenseUID, ExpenseNumber: expenseNumber }, `Created expense ${expenseNumber}`);
    return { Message: "Expense recorded successfully.", RedirectURL: "/expenses", ExpenseUID: expenseUID, ExpenseNumber: expenseNumber };
  }

  // updateExpense — the new total may not drop below what was paid; the status follows the paid amount
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const expenseUID = postInt(form, "ExpenseUID");
    const existing = await this.liveRecord(ctx.orgUID, expenseUID);
    if (existing.DocStatus === "Cancelled") throw new CiValidationError("This expense cannot be edited.");

    const data = ExpensesService.buildData(form, false);
    const net = data.NetAmount;
    const paid = round(existing.PaidAmount);
    if (paid > 0 && net < paid - 0.001) {
      throw new CiValidationError(`Amount cannot be less than ${await this.tk.lookups.currencySymbol(ctx.orgUID)} ${smartDecimal(paid)} (already paid).`);
    }

    await this.tk.db.write.transaction(async (trx) => {
      await this.repo.update(trx, ctx.orgUID, expenseUID, { ...data, ...ExpensesService.paymentState(net, paid), UpdatedBy: ctx.userUID });
      await this.saveItems(trx, ctx, form, expenseUID);
    });
    await this.attachments.remove(ctx, EXPENSE, postValue(form, "RemovedAttachIDs"));
    await this.attachments.save(ctx, EXPENSE, expenseUID, files);

    const expenseNumber = String(existing.ExpenseNumber ?? "");
    const vendorUID = Number(data.VendorUID) || 0;
    await this.tk.journal.postAfterSave(`Expense ${expenseUID}`, async (trx) => {
      await this.tk.journal.reverse(trx, ctx.orgUID, EXPENSE.sourceType, expenseUID, ctx.userUID);
      await this.tk.journal.postExpense(trx, this.journalOf(ctx, expenseUID, expenseNumber, data));
      if (vendorUID > 0) await this.tk.journal.ensurePaymentJournals(trx, ctx.orgUID, expenseUID, vendorUID, ctx.userUID);
    });
    if (vendorUID > 0) await this.vendorCache.refresh(ctx.orgUID, vendorUID);
    await this.log(ctx, "UPDATE", existing, `Updated expense ${expenseNumber}`);
    return { Message: "Expense updated successfully.", RedirectURL: "/expenses" };
  }

  // duplicateExpense — a Pending copy dated today (amounts, tax / TDS flags, category and notes)
  async duplicate(ctx: WriteContext, form: Form) {
    const source = await this.liveRecord(ctx.orgUID, postInt(form, "ExpenseUID"));
    const created = await this.tk.db.write.transaction(async (trx) => {
      const newUID = await this.repo.insert(trx, {
        OrgUID: ctx.orgUID,
        BranchUID: ctx.branchUID ?? 1,
        ModuleUID: EXPENSE.moduleUID,
        ExpenseDate: todayDate(),
        Amount: source.Amount,
        TaxApplicable: phpBool(source.TaxApplicable) ? 1 : 0,
        TaxPercentage: source.TaxPercentage ?? 0,
        TaxAmount: source.TaxAmount,
        TDSApplicable: phpBool(source.TDSApplicable) ? 1 : 0,
        TDSPercentage: source.TDSPercentage ?? 0,
        TDSAmount: source.TDSAmount,
        NetAmount: source.NetAmount,
        CategoryUID: source.CategoryUID,
        Notes: source.Notes,
        DocStatus: "Pending",
        IsPaid: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: ctx.userUID,
        UpdatedBy: ctx.userUID,
      });
      const number = `EXP-${String(newUID).padStart(4, "0")}`;
      await this.repo.setNumber(trx, ctx.orgUID, newUID, number);
      return { ExpenseUID: newUID, ExpenseNumber: number };
    });
    await this.log(ctx, "DUPLICATE", created, `Duplicated expense ${created.ExpenseNumber}`);
    return { Message: `${created.ExpenseNumber} created as a duplicate.`, ...(await this.listAfterChange(ctx, form)) };
  }

  // recordPayment: the vendor's payment journals are back-filled and its cache refreshed
  protected async afterPayment(ctx: WriteContext, record: Row): Promise<void> {
    const vendorUID = Number(record.VendorUID) || 0;
    if (vendorUID <= 0) return;
    const expenseUID = this.uidOf(record);
    await this.tk.journal.postAfterSave(`Expense ${expenseUID} payments`, (trx) => this.tk.journal.ensurePaymentJournals(trx, ctx.orgUID, expenseUID, vendorUID, ctx.userUID));
    await this.vendorCache.refresh(ctx.orgUID, vendorUID);
  }

  // updateExpenseStatus: marking Paid journals the payment to the vendor
  protected async afterStatusChange(ctx: WriteContext, record: Row, status: string, payment: RecordedPayment | null): Promise<void> {
    const vendorUID = Number(record.VendorUID) || 0;
    if (vendorUID <= 0) return;
    if (status === "Paid" && payment) {
      await this.tk.journal.postAfterSave(`Expense ${this.uidOf(record)} payment`, (trx) => this.postVendorPayment(trx, ctx, payment, Number(record.NetAmount), vendorUID));
    }
    await this.vendorCache.refresh(ctx.orgUID, vendorUID);
  }

  private postVendorPayment(trx: Knex.Transaction, ctx: WriteContext, payment: RecordedPayment, amount: number, vendorUID: number) {
    return this.tk.journal.postPayment(trx, {
      orgUID: ctx.orgUID,
      direction: "made",
      paymentUID: payment.paymentUID,
      date: payment.paymentDate,
      financialYear: payment.transYear,
      amount,
      partyUID: vendorUID,
      entityType: "Vendor",
      userUID: ctx.userUID,
    });
  }

  private journalOf(ctx: WriteContext, expenseUID: number, expenseNumber: string, data: Row) {
    return {
      orgUID: ctx.orgUID,
      recordUID: expenseUID,
      number: expenseNumber,
      date: String(data.ExpenseDate),
      netAmount: Number(data.NetAmount),
      userUID: ctx.userUID,
      vendorUID: Number(data.VendorUID) || 0,
      taxableAmount: Number(data.Amount) || 0,
      cgst: Number(data.CGSTTotal) || 0,
      sgst: Number(data.SGSTTotal) || 0,
      igst: Number(data.IGSTTotal) || 0,
    };
  }

  /**
   * _saveExpenseItems — with tax only: removed lines (DeletedItemUIDs) are soft-deleted, lines with an
   * ExpItemUID are updated and the rest inserted. Lines without an amount or total are skipped.
   */
  private async saveItems(trx: Knex.Transaction, ctx: WriteContext, form: Form, expenseUID: number): Promise<void> {
    if (!postInt(form, "TaxApplicable")) return;
    const removed = postJsonArray<unknown>(form, "DeletedItemUIDs")
      .map((uid) => parseInt(String(uid), 10))
      .filter((uid) => uid > 0);
    await this.repo.deleteItems(trx, ctx.orgUID, expenseUID, removed, ctx.userUID);

    for (const [index, row] of postJsonArray<ItemInput>(form, "Items").entries()) {
      const amount = round(row.Amount);
      const total = round(row.TotalAmount);
      if (amount <= 0 && total <= 0) continue;
      const item = {
        CategoryUID: Number(row.CategoryUID) > 0 ? parseInt(String(row.CategoryUID), 10) : null,
        ItemDescription: row.ItemDescription ? String(row.ItemDescription) : null,
        Amount: amount,
        TaxPercentage: phpRound(Number(row.TaxPercentage) || 0, 2),
        TaxAmount: round(row.TaxAmount),
        CGSTAmount: round(row.CGSTAmount),
        SGSTAmount: round(row.SGSTAmount),
        IGSTAmount: round(row.IGSTAmount),
        TotalAmount: total,
        SortOrder: index,
      };
      const itemUID = parseInt(String(row.ExpItemUID ?? 0), 10) || 0;
      if (itemUID > 0) await this.repo.updateItem(trx, ctx.orgUID, expenseUID, itemUID, { ...item, UpdatedBy: ctx.userUID });
      else await this.repo.insertItem(trx, { ExpenseUID: expenseUID, OrgUID: ctx.orgUID, ...item, IsDeleted: 0, CreatedBy: ctx.userUID, UpdatedBy: ctx.userUID });
    }
  }

  // DocStatus / IsPaid / PaidAmount / BalanceAmount of an edited expense from what was already paid
  private static paymentState(net: number, paid: number): Row {
    if (paid <= 0) return { DocStatus: "Pending", IsPaid: 0, PaidAmount: 0, BalanceAmount: net };
    if (round(net - paid) <= 0) return { DocStatus: "Paid", IsPaid: 1, PaidAmount: paid, BalanceAmount: 0 };
    return { DocStatus: "Partial", IsPaid: 0, PaidAmount: paid, BalanceAmount: round(net - paid) };
  }

  /**
   * _buildExpenseData — validates the form and works out the amounts. Without tax: SimpleAmount. With tax: the
   * sums of the Items lines (a vendor is required). NetAmount = total + round-off − TDS (TDS % of the total).
   */
  private static buildData(form: Form, isCreate: boolean) {
    const isPaid = postInt(form, "IsPaid") === 1 ? 1 : 0;
    const taxApplicable = postInt(form, "TaxApplicable") ? 1 : 0;
    const vendorUID = postInt(form, "VendorUID") || null;
    if (taxApplicable && !vendorUID) throw new CiValidationError("Please select a vendor.");
    let amountType: string | null = postString(form, "AmountType") || "TotalAmount";
    if (amountType === "TaxableAmount") amountType = "NetAmount";
    if (!AMOUNT_TYPES.includes(amountType)) amountType = "TotalAmount";
    if (isCreate && isPaid && !postInt(form, "PaymentTypeUID")) throw new CiValidationError("Please select a payment type.");

    let sums = { taxable: 0, tax: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
    if (!taxApplicable) {
      amountType = null;
      const simple = round(postValue(form, "SimpleAmount"));
      if (simple <= 0) throw new CiValidationError("Expense amount must be greater than 0.");
      sums = { ...sums, taxable: simple, total: simple };
    } else {
      const items = postJsonArray<ItemInput>(form, "Items");
      if (items.length === 0) throw new CiValidationError("At least one expense item is required.");
      for (const row of items) {
        sums.taxable += Number(row.Amount) || 0;
        sums.tax += Number(row.TaxAmount) || 0;
        sums.cgst += Number(row.CGSTAmount) || 0;
        sums.sgst += Number(row.SGSTAmount) || 0;
        sums.igst += Number(row.IGSTAmount) || 0;
        sums.total += Number(row.TotalAmount) || 0;
      }
      sums = { taxable: round(sums.taxable), tax: round(sums.tax), cgst: round(sums.cgst), sgst: round(sums.sgst), igst: round(sums.igst), total: round(sums.total) };
      if (sums.taxable <= 0 && sums.total <= 0) throw new CiValidationError("Expense amount must be greater than 0.");
    }

    const tdsApplicable = postInt(form, "TDSApplicable") ? 1 : 0;
    const tdsSectionUID = tdsApplicable ? Math.max(0, postInt(form, "TdsSectionUID")) : 0;
    if (tdsApplicable && tdsSectionUID <= 0) throw new CiValidationError("Please select a TDS section.");
    const tdsPercentage = tdsApplicable ? phpRound(Number(postValue(form, "TDSPercentage")) || 0, 2) : 0;
    const tdsAmount = tdsApplicable ? round((sums.total * tdsPercentage) / 100) : 0;
    const rcmApplicable = postInt(form, "RCMApplicable") ? 1 : 0;
    const roundOff = round(postValue(form, "RoundOff"));
    const netAmount = round(sums.total + roundOff - tdsAmount);

    return {
      ExpenseDate: postString(form, "ExpenseDate") || todayDate(),
      Amount: sums.taxable,
      TaxApplicable: taxApplicable,
      TaxPercentage: taxApplicable ? phpRound(Number(postValue(form, "TaxPercentage")) || 0, 2) : 0,
      TaxAmount: sums.tax,
      CGSTTotal: sums.cgst,
      SGSTTotal: sums.sgst,
      IGSTTotal: sums.igst,
      TDSApplicable: tdsApplicable,
      TdsSectionUID: tdsSectionUID,
      TDSPercentage: tdsPercentage,
      TDSAmount: tdsAmount,
      RCMApplicable: rcmApplicable,
      RCMAmount: rcmApplicable ? round(postValue(form, "RCMAmount")) : 0,
      RoundOff: roundOff,
      NetAmount: netAmount,
      VendorUID: vendorUID,
      SupplierInvoiceDate: postString(form, "SupplierInvoiceDate") || null,
      SupplierInvoiceSerialNo: postString(form, "SupplierInvoiceSerialNo") || null,
      AmountType: amountType,
      CategoryUID: postInt(form, "CategoryUID") || null,
      Notes: postString(form, "Notes") || null,
      DocStatus: isPaid ? "Paid" : "Pending",
      IsPaid: isPaid,
      IsActive: 1,
      IsDeleted: 0,
      ...(isCreate ? { PaidAmount: isPaid ? netAmount : 0, BalanceAmount: isPaid ? 0 : netAmount } : {}),
    };
  }
}
