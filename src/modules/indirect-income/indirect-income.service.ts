import { Injectable } from "@nestjs/common";
import { phpBool, phpRound, smartDecimal, todayDate } from "../../common/utils/php-compat";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { EntryAttachmentsService, UploadedFile } from "../expense-income/entry-attachments.service";
import { INCOME_CATEGORIES } from "../expense-income/entry-categories.service";
import { AMOUNT_DECIMALS, INDIRECT_INCOME } from "../expense-income/entry-kind";
import { EntryConfig, EntryRecordService, EntryToolkit, Form, Row } from "../expense-income/entry-record.service";
import { IndirectIncomeRepository } from "./indirect-income.repository";

const round = (value: unknown) => phpRound(Number(value) || 0, AMOUNT_DECIMALS);

const CONFIG: EntryConfig = {
  kind: INDIRECT_INCOME,
  categories: INCOME_CATEGORIES,
  uidField: "IncomeUID",
  bulkField: "IncomeUIDs",
  settledStatus: "Received",
  datePreference: "df_indirectincome",
  audit: { entity: "IndirectIncome", module: "IndirectIncome", action: "INCOME", noun: "income" },
  text: {
    invalid: "Invalid income record.",
    notFound: "Income not found.",
    cancelledNoDelete: "Cancelled income cannot be deleted.",
    deleted: "Income deleted.",
    paymentNotAllowed: "Payment can only be recorded for Pending or Partially Received income.",
    overpaid: (total, net) => `Total received (${total}) cannot exceed the income amount (${net}).`,
    settled: "Income marked as received.",
    bulkNoun: "income record(s)",
    paymentNarration: (full, number) => `${full ? "Income received" : "Income partially received"} — ${number}`,
    settledNarration: (number) => `Indirect income received — ${number}`,
  },
};

/**
 * Indirect Income page (CI3 Indirectincome controller): one amount per record, no tax. The journal debits
 * Accounts Receivable and credits Indirect Income; receipts go to the bank / cash book as credits.
 */
@Injectable()
export class IndirectIncomeService extends EntryRecordService {
  constructor(
    tk: EntryToolkit,
    private readonly repo: IndirectIncomeRepository,
    private readonly attachments: EntryAttachmentsService
  ) {
    super(tk, repo, CONFIG);
  }

  // Income lists carry SummaryStats whenever the organisation shows stats
  protected statsWanted(orgUID: number): Promise<boolean> {
    return this.tk.lookups.statsEnabled(orgUID);
  }

  // getIncomeDetail — the record with its attachments
  async getDetail(orgUID: number, incomeUID: number) {
    const income = await this.liveRecord(orgUID, incomeUID);
    return { Data: { ...income, Attachments: await this.tk.lookups.attachments(orgUID, INDIRECT_INCOME.sourceType, incomeUID) } };
  }

  // addIncome — the record, INC-{id} number and the receipt when IsReceived; then journal and files
  async create(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const data = IndirectIncomeService.buildData(form);
    const received = data.IsReceived === 1;
    const { incomeUID, incomeNumber } = await this.tk.db.write.transaction(async (trx) => {
      const uid = await this.repo.insert(trx, {
        ...data,
        OrgUID: ctx.orgUID,
        BranchUID: ctx.branchUID ?? 1,
        ModuleUID: INDIRECT_INCOME.moduleUID,
        // CI3 leaves these unset on create, so a new record showed no balance until its first receipt
        PaidAmount: received ? data.NetAmount : 0,
        BalanceAmount: received ? 0 : data.NetAmount,
        CreatedBy: ctx.userUID,
        UpdatedBy: ctx.userUID,
      });
      const number = `INC-${String(uid).padStart(4, "0")}`;
      await this.repo.setNumber(trx, ctx.orgUID, uid, number);
      if (received) await this.settlePayment(trx, ctx, form, { IncomeUID: uid, IncomeNumber: number, IncomeDate: data.IncomeDate }, data.NetAmount);
      return { incomeUID: uid, incomeNumber: number };
    });

    await this.postJournal(ctx, incomeUID, incomeNumber, data.IncomeDate, data.NetAmount, false);
    await this.attachments.save(ctx, INDIRECT_INCOME, incomeUID, files);
    await this.log(ctx, "ADD", { IncomeUID: incomeUID, IncomeNumber: incomeNumber }, `Created income ${incomeNumber}`);
    return { Message: "Income recorded successfully.", IncomeUID: incomeUID, IncomeNumber: incomeNumber, ...(await this.listAfterChange(ctx, form)) };
  }

  // updateIncome — the new amount may not drop below what was received; the status follows the received amount
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const incomeUID = postInt(form, "IncomeUID");
    const existing = await this.liveRecord(ctx.orgUID, incomeUID);
    if (existing.DocStatus === "Cancelled") throw new CiValidationError("This income cannot be edited.");

    const data = IndirectIncomeService.buildData(form);
    const net = round(data.NetAmount);
    const paid = round(existing.PaidAmount);
    if (paid > 0 && net < paid - 0.001) {
      throw new CiValidationError(`Amount cannot be less than ${await this.tk.lookups.currencySymbol(ctx.orgUID)} ${smartDecimal(paid)} (already received).`);
    }
    await this.repo.update(null, ctx.orgUID, incomeUID, { ...data, ...IndirectIncomeService.receiptState(net, paid), UpdatedBy: ctx.userUID });
    await this.attachments.remove(ctx, INDIRECT_INCOME, postValue(form, "RemovedAttachIDs"));
    await this.attachments.save(ctx, INDIRECT_INCOME, incomeUID, files);

    const incomeNumber = String(existing.IncomeNumber ?? "");
    await this.postJournal(ctx, incomeUID, incomeNumber, data.IncomeDate, data.NetAmount, true);
    await this.log(ctx, "UPDATE", existing, `Updated income ${incomeNumber}`);
    return { Message: "Income updated successfully.", ...(await this.listAfterChange(ctx, form)) };
  }

  // duplicateIncome — a Pending copy dated today
  async duplicate(ctx: WriteContext, form: Form) {
    const source = await this.liveRecord(ctx.orgUID, postInt(form, "IncomeUID"));
    const created = await this.tk.db.write.transaction(async (trx) => {
      const uid = await this.repo.insert(trx, {
        OrgUID: ctx.orgUID,
        BranchUID: ctx.branchUID ?? 1,
        ModuleUID: INDIRECT_INCOME.moduleUID,
        IncomeDate: todayDate(),
        Amount: source.Amount,
        TaxApplicable: phpBool(source.TaxApplicable) ? 1 : 0,
        TaxPercentage: source.TaxPercentage ?? 0,
        TaxAmount: source.TaxAmount,
        NetAmount: source.NetAmount,
        CategoryUID: source.CategoryUID,
        Notes: source.Notes,
        DocStatus: "Pending",
        IsReceived: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: ctx.userUID,
        UpdatedBy: ctx.userUID,
      });
      const number = `INC-${String(uid).padStart(4, "0")}`;
      await this.repo.setNumber(trx, ctx.orgUID, uid, number);
      return { IncomeUID: uid, IncomeNumber: number };
    });
    await this.log(ctx, "DUPLICATE", created, `Duplicated income ${created.IncomeNumber}`);
    return { Message: `${created.IncomeNumber} created as a duplicate.`, ...(await this.listAfterChange(ctx, form)) };
  }

  // postIndirectIncomeJournal (an edit reverses the old journal first)
  private postJournal(ctx: WriteContext, incomeUID: number, incomeNumber: string, date: string, netAmount: number, reverseFirst: boolean) {
    const { journal } = this.tk;
    return journal.postAfterSave(`IndirectIncome ${incomeUID}`, async (trx) => {
      if (reverseFirst) await journal.reverse(trx, ctx.orgUID, INDIRECT_INCOME.sourceType, incomeUID, ctx.userUID);
      await journal.postIndirectIncome(trx, { orgUID: ctx.orgUID, recordUID: incomeUID, number: incomeNumber, date, netAmount, userUID: ctx.userUID });
    });
  }

  // DocStatus / IsReceived / PaidAmount / BalanceAmount of an edited record from what was already received
  private static receiptState(net: number, paid: number): Row {
    if (paid <= 0) return { DocStatus: "Pending", IsReceived: 0, PaidAmount: 0, BalanceAmount: net };
    if (round(net - paid) <= 0) return { DocStatus: "Received", IsReceived: 1, PaidAmount: paid, BalanceAmount: 0 };
    return { DocStatus: "Partial", IsReceived: 0, PaidAmount: paid, BalanceAmount: round(net - paid) };
  }

  // _buildIncomeData — no tax: NetAmount is the amount
  private static buildData(form: Form) {
    const amount = Number(postValue(form, "Amount")) || 0;
    const isReceived = postInt(form, "IsReceived") === 1 ? 1 : 0;
    if (amount <= 0) throw new CiValidationError("Income amount must be greater than 0.");
    if (isReceived && !postInt(form, "PaymentTypeUID")) throw new CiValidationError("Please select a payment type.");
    return {
      IncomeDate: postString(form, "IncomeDate") || todayDate(),
      Amount: amount,
      TaxApplicable: 0,
      TaxPercentage: 0,
      TaxAmount: 0,
      NetAmount: amount,
      CategoryUID: postInt(form, "CategoryUID") || null,
      Notes: postString(form, "Notes") || null,
      DocStatus: isReceived ? "Received" : "Pending",
      IsReceived: isReceived,
      IsActive: 1,
      IsDeleted: 0,
    };
  }
}
