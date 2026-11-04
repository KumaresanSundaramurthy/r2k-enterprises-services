import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { phpRound } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { buildDateRange } from "../../core/utils/date-range";
import { postInt, postIntList, postJsonArray, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { JournalService } from "../../libraries/journal/journal.service";
import { UploadedFile } from "./entry-attachments.service";
import { CategoryKind, EntryCategoriesService } from "./entry-categories.service";
import { AMOUNT_DECIMALS, EntryKind } from "./entry-kind";
import { EntryPaymentsService, RecordedPayment } from "./entry-payments.service";
import { EntryListFilter, EntryRecordsRepository } from "./entry-records.repository";
import { EntryRepository } from "./entry.repository";

export type Form = Record<string, unknown>;
export type Row = Record<string, unknown>;

const round = (value: unknown) => phpRound(Number(value) || 0, AMOUNT_DECIMALS);

/** Services every expense / income flow uses, injected once and handed to the page services. */
@Injectable()
export class EntryToolkit {
  constructor(
    readonly db: DatabaseService,
    readonly lookups: EntryRepository,
    readonly payments: EntryPaymentsService,
    readonly categories: EntryCategoriesService,
    readonly journal: JournalService,
    readonly audit: AuditLogService,
    readonly orgSettings: OrgSettingsService
  ) {}
}

/** The page's wording and names, where CI3's two controllers differ only in text. */
export interface EntryConfig {
  kind: EntryKind;
  categories: CategoryKind;
  // Posted field with the record's UID (ExpenseUID / IncomeUID) and the bulk-delete list (ExpenseUIDs / IncomeUIDs)
  uidField: string;
  bulkField: string;
  // Paid (expenses) / Received (income)
  settledStatus: string;
  // Users.UserPreferencesTbl key of the page's saved date filter
  datePreference: string;
  audit: { entity: string; module: string; action: string; noun: string };
  text: {
    invalid: string;
    notFound: string;
    cancelledNoDelete: string;
    deleted: string;
    paymentNotAllowed: string;
    overpaid: (total: number, net: number) => string;
    settled: string;
    bulkNoun: string;
    // Bank / cash book narration of a payment from the payment modal, and of one made when the record is settled outright
    paymentNarration: (full: boolean, number: string) => string;
    settledNarration: (number: string) => string;
  };
}

/**
 * The flows the expense and indirect income pages share (CI3 controllers): list, delete, bulk delete,
 * record payment, status change and the payment popups. Each page's service extends this with its own
 * create / update / duplicate and the vendor-related steps expenses add.
 */
export abstract class EntryRecordService {
  protected constructor(
    protected readonly tk: EntryToolkit,
    protected readonly records: EntryRecordsRepository,
    protected readonly config: EntryConfig
  ) {}

  // Whether a list response carries SummaryStats (expenses: when the page asks; income: the organisation's setting)
  protected abstract statsWanted(orgUID: number, form: Form): Promise<boolean>;

  // After a payment from the payment modal is saved (expenses: vendor journals and cache)
  protected async afterPayment(_ctx: WriteContext, _record: Row): Promise<void> {}

  // After a status change is saved (expenses: vendor payment journal and cache)
  protected async afterStatusChange(_ctx: WriteContext, _record: Row, _status: string, _payment: RecordedPayment | null): Promise<void> {}

  // index — dropdowns, filter users and the saved date range (default this month)
  async getPageData(orgUID: number, branchUID: number, userUID: number) {
    const { tk } = this;
    const [settings, saved, categories, paymentTypes, bankAccounts, users, showStats] = await Promise.all([
      tk.orgSettings.get(orgUID),
      tk.lookups.preference(orgUID, branchUID, userUID, this.config.datePreference),
      tk.categories.dropdown(this.config.categories, orgUID),
      tk.lookups.paymentTypes(),
      tk.lookups.bankAccounts(orgUID),
      tk.lookups.orgUsers(orgUID),
      tk.lookups.statsEnabled(orgUID),
    ]);
    const range = buildDateRange(saved || "this_month", settings.Timezone);
    return {
      Categories: categories,
      PaymentTypes: paymentTypes,
      BankAccounts: bankAccounts,
      OrgUsers: users,
      ShowUserFilter: users.length > 1,
      ShowStats: showStats,
      SummaryStats: showStats ? await this.records.summaryStats(orgUID, branchUID) : {},
      RowLimit: settings.RowLimit,
      SavedDateRange: range.range,
      SavedDateLabel: range.label,
      SavedDateFrom: range.from,
      SavedDateTo: range.to,
      InitFilter: { Status: "All", DateFrom: range.from, DateTo: range.to },
    };
  }

  // getPageDetails — the CI3 JS builds the rows from Data
  async getPage(orgUID: number, branchUID: number, pageNo: number, form: Form, filter: EntryListFilter) {
    const limit = await this.tk.orgSettings.resolveRowLimit(orgUID, postInt(form, "RowLimit") || undefined);
    const scoped = { ...filter, BranchUID: branchUID };
    const [rows, total, stats] = await Promise.all([
      this.records.list(orgUID, scoped, limit, (pageNo - 1) * limit),
      this.records.count(orgUID, scoped),
      this.statsWanted(orgUID, form).then((wanted) => (wanted ? this.records.summaryStats(orgUID, branchUID) : undefined)),
    ]);
    return { Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: limit, ...(stats ? { SummaryStats: stats } : {}) };
  }

  // _appendListResponse — the first page for the posted Filter / RowLimit (default: all statuses)
  protected async listAfterChange(ctx: WriteContext, form: Form) {
    const filter = EntryRecordService.postedFilter(form.Filter) ?? { Status: "All" };
    return this.getPage(ctx.orgUID, ctx.branchUID ?? 1, 1, form, filter);
  }

  // delete — soft-deletes the record and its linked payment, then reverses its journal
  async delete(ctx: WriteContext, form: Form) {
    const record = await this.liveRecord(ctx.orgUID, postInt(form, this.config.uidField));
    if (record.DocStatus === "Cancelled") throw new CiValidationError(this.config.text.cancelledNoDelete);
    await this.softDelete(ctx, record);
    await this.log(ctx, "DELETE", record, `Deleted ${this.config.audit.noun} ${this.numberOf(record)}`);
    return { Message: this.config.text.deleted, ...(await this.listAfterChange(ctx, form)) };
  }

  // deleteMultiple… — the posted UIDs or, with SelectAll = 1, every record matching the Filter; each one on its own
  async deleteBulk(ctx: WriteContext, form: Form) {
    let uids: number[];
    if (postInt(form, "SelectAll") === 1) {
      const filter = EntryRecordService.postedFilter(form.Filter) ?? {};
      uids = await this.records.uidsByFilter(ctx.orgUID, { ...filter, BranchUID: ctx.branchUID ?? 1 });
    } else {
      // An array (CI3's ExpenseUIDs[] / IncomeUIDs[]), a JSON array or a comma-separated list
      const posted = postJsonArray<unknown>(form, this.config.bulkField);
      uids = posted.length > 0 ? posted.map((uid) => parseInt(String(uid), 10)).filter((uid) => uid > 0) : postIntList(form, this.config.bulkField);
    }
    if (uids.length === 0) throw new CiValidationError("No records selected.");

    let deleted = 0;
    const errors: string[] = [];
    for (const uid of uids) {
      try {
        const record = await this.records.find(ctx.orgUID, uid);
        if (!record) {
          errors.push(`#${uid}: not found`);
          continue;
        }
        if (record.DocStatus === "Cancelled") {
          errors.push(`#${uid}: already cancelled`);
          continue;
        }
        await this.softDelete(ctx, record);
        deleted++;
      } catch (err) {
        errors.push(`#${uid}: ${(err as Error).message}`);
      }
    }
    if (deleted === 0) throw new CiValidationError(errors.join("; ") || "No records deleted.");

    await this.tk.audit.log(ctx, {
      action: `BULK_DELETE_${this.config.audit.action}`,
      entityType: this.config.audit.entity,
      entityUID: 0,
      entityRef: "",
      summary: `Bulk deleted ${deleted} ${this.config.text.bulkNoun}`,
      module: this.config.audit.module,
      category: "TRANSACTION",
    });
    return { Message: `${deleted} ${this.config.text.bulkNoun} deleted.` + (errors.length > 0 ? ` Skipped: ${errors.join("; ")}` : "") };
  }

  // recordPayment — a full or part payment from the payment modal (PaymentFiles[] attached to it)
  async recordPayment(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const { config, records } = this;
    const { text } = config;
    const record = await this.liveRecord(ctx.orgUID, postInt(form, "TransUID"));
    if (!["Pending", "Partial"].includes(String(record.DocStatus))) throw new CiValidationError(text.paymentNotAllowed);

    const paymentTypeUID = postInt(form, "PaymentTypeUID");
    const amount = round(postValue(form, "Amount"));
    if (!paymentTypeUID) throw new CiValidationError("Please select a payment type.");
    if (amount <= 0) throw new CiValidationError("Payment amount must be greater than 0.");

    const net = round(record.NetAmount);
    let paid = round(round(record.PaidAmount) + amount);
    if (paid > net + 0.01) throw new CiValidationError(text.overpaid(paid, net));
    paid = Math.min(paid, net);
    const balance = Math.max(0, round(net - paid));
    const full = balance <= 0;
    const number = this.numberOf(record);
    const uid = this.uidOf(record);

    const payment = await this.tk.db.write.transaction(async (trx) => {
      await records.update(trx, ctx.orgUID, uid, {
        DocStatus: full ? config.settledStatus : "Partial",
        [records.spec.settledColumn]: full ? 1 : 0,
        PaidAmount: paid,
        BalanceAmount: balance,
        UpdatedBy: ctx.userUID,
      });
      return this.tk.payments.record(trx, config.kind, ctx, {
        transUID: uid,
        transNumber: number,
        amount,
        date: postString(form, "PaymentDate") || this.dateOf(record),
        paymentTypeUID,
        bankAccountUID: postInt(form, "BankAccountUID") || null,
        notes: postString(form, "Notes"),
        referenceNo: postString(form, "ReferenceNo"),
        isFullyPaid: full,
        narration: text.paymentNarration(full, number),
      });
    });
    await this.tk.payments.saveFiles(ctx, payment.paymentUID, files);
    await this.afterPayment(ctx, record);

    await this.tk.audit.log(ctx, {
      action: `RECORD_${config.audit.action}_PAYMENT`,
      entityType: config.audit.entity,
      entityUID: uid,
      entityRef: number,
      details: { Amount: amount },
      summary: `Recorded payment for ${config.audit.noun} ${number}`,
      module: config.audit.module,
      category: "PAYMENT",
    });
    const message = full ? text.settled : `Partial payment recorded. Balance remaining: ${balance}.`;
    return { Message: message, ...(await this.listAfterChange(ctx, form)) };
  }

  // update…Status — Pending → settled / Cancelled, settled → Cancelled. Settling records one payment for the full amount.
  async updateStatus(ctx: WriteContext, form: Form) {
    const { config, records } = this;
    const uid = postInt(form, config.uidField);
    const status = String(postValue(form, "Status") ?? "").trim();
    if (uid <= 0) throw new CiValidationError(config.text.invalid);
    if (!status) throw new CiValidationError("Status is required.");
    const record = await this.liveRecord(ctx.orgUID, uid);

    const allowed: Record<string, string[]> = { Pending: [config.settledStatus, "Cancelled"], [config.settledStatus]: ["Cancelled"] };
    if (!allowed[String(record.DocStatus)]?.includes(status)) throw new CiValidationError("Invalid status transition.");
    const settling = status === config.settledStatus;
    const net = round(record.NetAmount);

    const payment = await this.tk.db.write.transaction(async (trx) => {
      await records.update(trx, ctx.orgUID, uid, {
        DocStatus: status,
        [records.spec.settledColumn]: settling ? 1 : 0,
        // CI3 leaves PaidAmount / BalanceAmount as they were, so a record settled here kept showing its full balance
        ...(settling ? { PaidAmount: net, BalanceAmount: 0 } : {}),
        UpdatedBy: ctx.userUID,
      });
      if (settling) return this.settlePayment(trx, ctx, form, record, net);
      if (status === "Cancelled" && Number(record.PaymentUID) > 0) await this.tk.lookups.voidPayment(trx, ctx.orgUID, Number(record.PaymentUID), ctx.userUID);
      return null;
    });

    if (status === "Cancelled") {
      await this.tk.journal.postAfterSave(`${config.kind.sourceType} ${uid} reversal`, (trx) => this.tk.journal.reverse(trx, ctx.orgUID, config.kind.sourceType, uid, ctx.userUID));
    }
    await this.afterStatusChange(ctx, record, status, payment);
    await this.log(ctx, "UPDATE", record, `Updated ${config.audit.noun} status ${this.numberOf(record)}`, { NewStatus: status }, "_STATUS");
    return { Message: `Status updated to ${status}.`, ...(await this.listAfterChange(ctx, form)) };
  }

  // getPaymentHistory
  paymentHistory(orgUID: number, transUID: number) {
    return this.tk.payments.history(orgUID, this.config.kind, transUID, this.config.text.invalid);
  }

  // getPaymentAttachments
  paymentAttachments(orgUID: number, transUID: number) {
    return this.tk.payments.attachmentsOf(orgUID, this.config.kind, transUID, this.config.text.invalid);
  }

  // getCategories
  async getCategories(orgUID: number) {
    return { Data: await this.tk.categories.dropdown(this.config.categories, orgUID) };
  }

  // getCategoryList
  getCategoryList(orgUID: number, form: Form) {
    return this.tk.categories.list(this.config.categories, orgUID, EntryRecordService.categoryQuery(form));
  }

  // The payment made when a record is created or marked settled: the full amount, from the add / status form
  protected settlePayment(trx: Knex.Transaction, ctx: WriteContext, form: Form, record: Row, net: number): Promise<RecordedPayment> {
    const number = this.numberOf(record);
    return this.tk.payments.record(trx, this.config.kind, ctx, {
      transUID: this.uidOf(record),
      transNumber: number,
      amount: net,
      date: postString(form, "PaymentDate") || this.dateOf(record),
      paymentTypeUID: postInt(form, "PaymentTypeUID"),
      bankAccountUID: postInt(form, "BankAccountUID") || null,
      notes: postString(form, "PaymentNotes"),
      referenceNo: null,
      isFullyPaid: true,
      narration: this.config.text.settledNarration(number),
    });
  }

  // The organisation's live record, or the page's "invalid" / "not found" message
  protected async liveRecord(orgUID: number, uid: number): Promise<Row> {
    if (uid <= 0) throw new CiValidationError(this.config.text.invalid);
    const record = await this.records.find(orgUID, uid);
    if (!record) throw new CiValidationError(this.config.text.notFound);
    return record;
  }

  // Soft-delete with the linked payment, then the journal reversal (which never fails the delete)
  private async softDelete(ctx: WriteContext, record: Row): Promise<void> {
    const uid = this.uidOf(record);
    await this.tk.db.write.transaction(async (trx) => {
      await this.records.update(trx, ctx.orgUID, uid, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
      if (Number(record.PaymentUID) > 0) await this.tk.lookups.voidPayment(trx, ctx.orgUID, Number(record.PaymentUID), ctx.userUID);
    });
    const { sourceType } = this.config.kind;
    await this.tk.journal.postAfterSave(`${sourceType} ${uid} reversal`, (trx) => this.tk.journal.reverse(trx, ctx.orgUID, sourceType, uid, ctx.userUID));
  }

  protected log(ctx: WriteContext, verb: string, record: Row, summary: string, details: Row = {}, suffix = "") {
    return this.tk.audit.log(ctx, {
      action: `${verb}_${this.config.audit.action}${suffix}`,
      entityType: this.config.audit.entity,
      entityUID: this.uidOf(record),
      entityRef: this.numberOf(record),
      details,
      summary,
      module: this.config.audit.module,
      category: "TRANSACTION",
    });
  }

  protected uidOf(record: Row): number {
    return Number(record[this.records.spec.uidColumn]);
  }

  protected numberOf(record: Row): string {
    return String(record[this.records.spec.numberColumn] ?? "");
  }

  protected dateOf(record: Row): string {
    return String(record[this.records.spec.dateColumn] ?? "");
  }

  // Filter posted as JSON or as an object; null when absent or unreadable
  protected static postedFilter(value: unknown): EntryListFilter | null {
    if (value && typeof value === "object") return value as EntryListFilter;
    if (typeof value !== "string" || !value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as EntryListFilter) : null;
    } catch {
      return null;
    }
  }

  // The category manager's PageNo / Search
  protected static categoryQuery(form: Form) {
    return { pageNo: postInt(form, "PageNo") || 1, search: String(postValue(form, "Search") ?? "") };
  }
}
