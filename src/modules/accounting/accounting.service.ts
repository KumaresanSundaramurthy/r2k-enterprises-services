import { Injectable } from "@nestjs/common";
import { phpDate } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { JournalService } from "../../libraries/journal/journal.service";
import { arrayOf, filterOf, nowIn, todayIn } from "../hrms/hrms-common";
import { advanceRunDate, calcBalance, FREQUENCIES, isIsoDate, LEDGER_TYPES, num, round, Side, sideOf, toIsoDate } from "./accounting-common";
import { AccountingRepository, Filter, Row } from "./accounting.repository";

type Form = Record<string, unknown>;
interface JournalLine { LedgerUID: number; Type: Side; Amount: number; Particulars: string }

const AMOUNT_DECIMALS = 2;

// CI3 smartDecimal for the "does not balance" message
const plain = (n: number) => String(Number(n.toFixed(9)));

/** CI3 Accounting controller: Chart of Accounts, journals, manual / recurring journals, bank reconciliation, period lock, budgets. */
@Injectable()
export class AccountingService {
  constructor(
    private readonly repo: AccountingRepository,
    private readonly db: DatabaseService,
    private readonly journal: JournalService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  private async today(orgUID: number): Promise<string> {
    return todayIn((await this.orgSettings.get(orgUID)).Timezone);
  }

  private async limitOf(orgUID: number, requested?: number): Promise<number> {
    return this.orgSettings.resolveRowLimit(orgUID, requested && requested > 0 ? requested : undefined);
  }

  // ── Chart of Accounts ─────────────────────────────────────────────────────

  // chartofaccounts — Stats, the first page and the parent-ledger dropdown
  async chartPageData(orgUID: number, rowLimit?: number) {
    const [page, ParentLedgers] = await Promise.all([this.chartPage(orgUID, 1, rowLimit, {}), this.repo.activeLedgers(orgUID)]);
    return { ...page, ParentLedgers };
  }

  // getChartOfAccountsPage — Filter { LedgerType, SearchAllData }
  async chartPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter) {
    const limit = await this.limitOf(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const [Data, TotalCount, Stats] = await Promise.all([
      this.repo.chartList(orgUID, filter, limit, (page - 1) * limit),
      this.repo.chartCount(orgUID, filter),
      this.repo.chartStats(orgUID),
    ]);
    return { Data, TotalCount, PageNo: page, RowLimit: limit, Stats };
  }

  // saveLedger — LedgerUID 0 creates (code required, unique per organisation); the code of an existing ledger never changes
  async saveLedger(ctx: WriteContext, form: Form) {
    const ledgerUID = postInt(form, "LedgerUID");
    const code = String(form.LedgerCode ?? "").trim();
    const name = String(form.LedgerName ?? "").trim();
    const type = String(form.LedgerType ?? "").trim();
    const parentUID = postInt(form, "ParentLedgerUID") || null;
    const opening = round(num(form.OpeningBalance), AMOUNT_DECIMALS);
    const openingType: Side = form.OpeningBalanceType === "Credit" ? "Credit" : "Debit";

    if (!name) throw new CiValidationError("Ledger name is required.");
    if (!(LEDGER_TYPES as readonly string[]).includes(type)) throw new CiValidationError("Invalid ledger type.");
    if (opening < 0) throw new CiValidationError("Opening balance cannot be negative.");
    if (parentUID) {
      if (parentUID === ledgerUID) throw new CiValidationError("A ledger cannot be its own parent.");
      if (!(await this.repo.orgLedgerUIDs(ctx.orgUID, [parentUID])).has(parentUID)) throw new CiValidationError("Parent ledger not found.");
    }

    const data: Row = { LedgerName: name, LedgerType: type, ParentLedgerUID: parentUID, OpeningBalance: opening, OpeningBalanceType: openingType, UpdatedBy: ctx.userUID };
    let message: string;
    if (ledgerUID > 0) {
      if (!(await this.repo.updateLedger(ctx.orgUID, ledgerUID, data))) throw new CiValidationError("Ledger not found.");
      message = "Ledger updated successfully.";
    } else {
      if (!code) throw new CiValidationError("Ledger code is required.");
      if (await this.repo.ledgerCodeTaken(ctx.orgUID, code)) throw new CiValidationError(`Ledger code ${code} is already used.`);
      await this.repo.insertLedger({
        ...data,
        OrgUID: ctx.orgUID,
        LedgerCode: code,
        CurrentBalance: opening,
        CurrentBalanceType: openingType,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: ctx.userUID,
      });
      message = "Ledger created successfully.";
    }
    return { Message: message, ...(await this.chartPage(ctx.orgUID, 1, postInt(form, "RowLimit") || undefined, filterOf(form.Filter))) };
  }

  // toggleLedgerStatus
  async toggleLedger(ctx: WriteContext, form: Form) {
    const ledgerUID = postInt(form, "LedgerUID");
    const status = String(form.IsActive ?? "");
    if (!ledgerUID) throw new CiValidationError("Invalid ledger.");
    if (status !== "0" && status !== "1") throw new CiValidationError("Invalid status.");
    if (!(await this.repo.updateLedger(ctx.orgUID, ledgerUID, { IsActive: Number(status), UpdatedBy: ctx.userUID }))) throw new CiValidationError("Ledger not found.");
    return {
      Message: status === "1" ? "Ledger activated." : "Ledger deactivated.",
      ...(await this.chartPage(ctx.orgUID, 1, postInt(form, "RowLimit") || undefined, filterOf(form.Filter))),
    };
  }

  // deleteLedger — only a ledger without journal entries
  async deleteLedger(ctx: WriteContext, form: Form) {
    const ledgerUID = postInt(form, "LedgerUID");
    if (!ledgerUID) throw new CiValidationError("Invalid ledger.");
    if (await this.repo.ledgerHasEntries(ctx.orgUID, ledgerUID)) throw new CiValidationError("Cannot delete a ledger that has journal entries.");
    if (!(await this.repo.updateLedger(ctx.orgUID, ledgerUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID }))) throw new CiValidationError("Ledger not found.");
    return { Message: "Ledger deleted.", ...(await this.chartPage(ctx.orgUID, 1, postInt(form, "RowLimit") || undefined, filterOf(form.Filter))) };
  }

  // getLedgersForJournal — select2 search ({results: [{id, text, code, type}]})
  async ledgersForJournal(orgUID: number, search: string) {
    const rows = await this.repo.activeLedgers(orgUID, search.trim(), 50);
    return { results: rows.map((r) => ({ id: Number(r.LedgerUID), text: `${r.LedgerName} (${r.LedgerType})`, code: r.LedgerCode, type: r.LedgerType })) };
  }

  // ── Journal list ──────────────────────────────────────────────────────────

  // journallist — Stats and the first page
  async journalPageData(orgUID: number, rowLimit?: number) {
    return this.journalPage(orgUID, 1, rowLimit, {});
  }

  // getJournalListPage — Filter { ReferenceType, DateFrom, DateTo, SearchAllData }
  async journalPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter) {
    const limit = await this.limitOf(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const [Data, TotalCount, Stats] = await Promise.all([
      this.repo.journalList(orgUID, filter, limit, (page - 1) * limit),
      this.repo.journalCount(orgUID, filter),
      this.repo.journalStats(orgUID),
    ]);
    return { Data, TotalCount, PageNo: page, RowLimit: limit, Stats };
  }

  // getJournalDetail
  async journalDetail(orgUID: number, journalUID: number) {
    if (!journalUID) throw new CiValidationError("Invalid journal.");
    const journal = await this.repo.journalWithEntries(orgUID, journalUID);
    if (!journal) throw new CiValidationError("Journal not found.");
    return { Journal: journal, JournalNo: journal.JournalNo };
  }

  // ── Manual journals ───────────────────────────────────────────────────────

  // Lines of the organisation's active ledgers, Debit / Credit, amount > 0; at least two, balanced
  private async journalLines(orgUID: number, raw: unknown, strict: boolean): Promise<JournalLine[]> {
    const lines: JournalLine[] = [];
    for (const line of arrayOf<Row>(raw)) {
      const ledgerUID = Number(line?.LedgerUID) || 0;
      const type = String(line?.Type ?? line?.TransactionType ?? "").trim();
      const amount = round(num(line?.Amount), AMOUNT_DECIMALS);
      if (strict) {
        if (amount <= 0) throw new CiValidationError("Line amount must be greater than zero.");
        if (!ledgerUID) throw new CiValidationError("All lines must have a ledger account.");
        if (type !== "Debit" && type !== "Credit") throw new CiValidationError("Invalid line type.");
      } else if (!ledgerUID || (type !== "Debit" && type !== "Credit") || amount <= 0) {
        continue; // saveManualJournal skips incomplete rows, as CI3
      }
      lines.push({ LedgerUID: ledgerUID, Type: type as Side, Amount: amount, Particulars: String(line?.Particulars ?? "").trim() });
    }
    if (lines.length < 2) throw new CiValidationError(strict ? "At least 2 journal lines required." : "At least 2 valid journal lines are required.");

    const known = await this.repo.orgLedgerUIDs(orgUID, [...new Set(lines.map((l) => l.LedgerUID))], true);
    const unknown = lines.find((l) => !known.has(l.LedgerUID));
    if (unknown) throw new CiValidationError(`Ledger #${unknown.LedgerUID} is not an active ledger of this organisation.`);

    const debit = lines.filter((l) => l.Type === "Debit").reduce((s, l) => s + l.Amount, 0);
    const credit = lines.filter((l) => l.Type === "Credit").reduce((s, l) => s + l.Amount, 0);
    if (Math.abs(debit - credit) > 0.01) {
      throw new CiValidationError(strict ? "Journal is not balanced. Debit total must equal credit total." : `Journal does not balance — Debit: ${plain(debit)}, Credit: ${plain(credit)}.`);
    }
    return lines;
  }

  // saveManualJournal — posted in one transaction (CI3 could leave a half-written journal)
  async saveManualJournal(ctx: WriteContext, form: Form) {
    const date = String(form.JournalDate ?? "").trim();
    const narration = String(form.Narration ?? "").trim();
    if (!date) throw new CiValidationError("Journal date is required.");
    if (!isIsoDate(date)) throw new CiValidationError("Invalid journal date.");
    if (!narration) throw new CiValidationError("Narration is required.");
    if (arrayOf(form.Lines).length < 2) throw new CiValidationError("At least 2 journal lines are required.");
    const lines = await this.journalLines(ctx.orgUID, form.Lines, false);

    const posted = await this.db.write.transaction((trx) => this.journal.postManual(trx, ctx.orgUID, date, narration, lines, ctx.userUID, "Manual"));
    return { Message: `Journal entry ${posted.journalNo} saved successfully.`, JournalNo: posted.journalNo, JournalUID: posted.journalUID };
  }

  // deleteManualJournal — only a live Manual journal; soft-deleted and reversed today
  async deleteManualJournal(ctx: WriteContext, journalUID: number) {
    if (!journalUID) throw new CiValidationError("Invalid journal.");
    const today = await this.today(ctx.orgUID);
    const done = await this.db.write.transaction((trx) => this.journal.reverseManual(trx, ctx.orgUID, journalUID, ctx.userUID, today));
    if (!done) throw new CiValidationError("Journal not found or cannot be deleted.");
    return { Message: "Journal reversed and deleted successfully." };
  }

  // ── Bank reconciliation ───────────────────────────────────────────────────

  // bankreconciliation — the active bank / cash ledgers
  async bankReconPageData(orgUID: number) {
    return { BankLedgers: await this.repo.activeLedgers(orgUID, "", 0, ["Bank", "Cash"]) };
  }

  // getBankReconAjax — the ledger's entries in the range, book and cleared balances
  async bankRecon(orgUID: number, ledgerUID: number, rawFrom: unknown, rawTo: unknown) {
    if (!ledgerUID) throw new CiValidationError("Please select a bank account.");
    const ledger = await this.repo.ledger(orgUID, ledgerUID);
    if (!ledger) throw new CiValidationError("Bank account not found.");
    const dateFrom = toIsoDate(rawFrom);
    const dateTo = toIsoDate(rawTo);

    let [opening, openingType] = [num(ledger.OpeningBalance), sideOf(ledger.OpeningBalanceType)];
    if (dateFrom) {
      const prior = await this.repo.activityBefore(orgUID, ledgerUID, dateFrom);
      [opening, openingType] = calcBalance(opening, openingType, prior.debit, prior.credit);
    }
    const hasRecon = await this.repo.hasReconColumn();
    const entries = await this.repo.ledgerStatement(orgUID, ledgerUID, dateFrom, dateTo, hasRecon);

    let totalDr = 0, totalCr = 0, clearedDr = 0, clearedCr = 0;
    for (const e of entries) {
      const amount = num(e.Amount);
      const cleared = Number(e.IsReconciled) === 1;
      if (e.TransactionType === "Debit") {
        totalDr += amount;
        if (cleared) clearedDr += amount;
      } else {
        totalCr += amount;
        if (cleared) clearedCr += amount;
      }
    }
    const [BookBalance, BookType] = calcBalance(opening, openingType, totalDr, totalCr);
    const [ClearedBalance, ClearedType] = calcBalance(opening, openingType, clearedDr, clearedCr);
    return {
      Entries: entries,
      LedgerName: ledger.LedgerName,
      OpeningBalance: opening,
      OpeningType: openingType,
      TotalDr: totalDr,
      TotalCr: totalCr,
      BookBalance,
      BookType,
      ClearedBalance,
      ClearedType,
      EntryCount: entries.length,
      ReconciliationEnabled: hasRecon,
    };
  }

  // saveBankRecon — ClearedUIDs / UnclearedUIDs of the organisation's bank / cash entries
  async saveBankRecon(ctx: WriteContext, form: Form) {
    if (!(await this.repo.hasReconColumn())) {
      throw new CiValidationError(
        "Bank reconciliation is not set up: Accounting.JournalEntries has no IsReconciled column. Run: ALTER TABLE Accounting.JournalEntries ADD COLUMN IsReconciled BIT(1) NOT NULL DEFAULT b'0';"
      );
    }
    const ids = (key: string) => [...new Set(arrayOf(form[key] ?? form[`${key}[]`]).map(Number).filter((n) => n > 0))];
    const cleared = ids("ClearedUIDs");
    const uncleared = ids("UnclearedUIDs");
    await this.repo.setReconciled(ctx.orgUID, cleared, 1);
    await this.repo.setReconciled(ctx.orgUID, uncleared, 0);
    return { Message: `${cleared.length} entries marked cleared, ${uncleared.length} uncleared.`, ClearedCount: cleared.length, UnclearedCount: uncleared.length };
  }

  // ── Recurring journals ────────────────────────────────────────────────────

  // recurringjournals — Stats and the first page
  async recurringPageData(orgUID: number, rowLimit?: number) {
    return this.recurringPage(orgUID, 1, rowLimit, {});
  }

  // getRecurringJournalsPage — Filter { IsActive, Due, SearchAllData }
  async recurringPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter) {
    const [limit, today] = await Promise.all([this.limitOf(orgUID, rowLimit), this.today(orgUID)]);
    const page = Math.max(1, pageNo);
    const [Data, TotalCount, Stats] = await Promise.all([
      this.repo.recurringList(orgUID, filter, today, limit, (page - 1) * limit),
      this.repo.recurringCount(orgUID, filter, today),
      this.repo.recurringStats(orgUID, today),
    ]);
    return { Data, TotalCount, PageNo: page, RowLimit: limit, Stats };
  }

  // getRecurringJournalAjax — one recurring journal for the edit form
  async recurringDetail(orgUID: number, recurUID: number) {
    if (!recurUID) throw new CiValidationError("Invalid recurring journal.");
    const journal = await this.repo.recurring(orgUID, recurUID);
    if (!journal) throw new CiValidationError("Recurring journal not found.");
    return {
      RecurUID: Number(journal.RecurUID),
      Title: journal.Title,
      Narration: journal.Narration,
      Frequency: journal.Frequency,
      StartDate: journal.StartDate,
      EndDate: journal.EndDate ?? "",
      Lines: (journal.Lines as Row[]).map((l) => ({
        LedgerUID: Number(l.LedgerUID),
        LedgerName: `${l.LedgerName} (${l.LedgerType})`,
        TransactionType: l.TransactionType,
        Amount: num(l.Amount),
        Particulars: l.Particulars,
      })),
    };
  }

  // saveRecurringJournal — header and lines in one transaction; an update replaces the lines
  async saveRecurring(ctx: WriteContext, form: Form) {
    const recurUID = postInt(form, "RecurUID");
    const title = String(form.Title ?? "").trim();
    const narration = String(form.Narration ?? "").trim();
    const frequency = String(form.Frequency || "Monthly");
    const startDate = String(form.StartDate ?? "").trim();
    const endDate = String(form.EndDate ?? "").trim() || null;

    if (!title) throw new CiValidationError("Title is required.");
    if (!narration) throw new CiValidationError("Narration is required.");
    if (!startDate) throw new CiValidationError("Start date is required.");
    if (!isIsoDate(startDate)) throw new CiValidationError("Invalid start date format.");
    if (endDate && !isIsoDate(endDate)) throw new CiValidationError("Invalid end date format.");
    if (endDate && endDate < startDate) throw new CiValidationError("End date cannot be before the start date.");
    if (!(FREQUENCIES as readonly string[]).includes(frequency)) throw new CiValidationError("Invalid frequency.");
    const lines = await this.journalLines(ctx.orgUID, form.Lines, true);

    const savedUID = await this.db.write.transaction(async (trx) => {
      let uid = recurUID;
      if (uid > 0) {
        const changed = await this.repo.updateRecurring(ctx.orgUID, uid, { Title: title, Narration: narration, Frequency: frequency, StartDate: startDate, EndDate: endDate, UpdatedBy: ctx.userUID }, trx);
        if (!changed) throw new CiValidationError("Recurring journal not found.");
      } else {
        uid = await this.repo.insertRecurring(trx, {
          OrgUID: ctx.orgUID, Title: title, Narration: narration, Frequency: frequency, StartDate: startDate, EndDate: endDate,
          NextRunDate: startDate, IsActive: 1, CreatedBy: ctx.userUID,
        });
      }
      await this.repo.replaceRecurringLines(trx, ctx.orgUID, uid, lines.map((l, i) => ({
        RecurUID: uid, OrgUID: ctx.orgUID, LedgerUID: l.LedgerUID, TransactionType: l.Type, Amount: l.Amount, Particulars: l.Particulars, SortOrder: i,
      })));
      return uid;
    });
    return { Message: recurUID > 0 ? "Recurring journal updated." : "Recurring journal created.", RecurUID: savedUID };
  }

  // Posts one recurring journal today and moves its next run on (paused when past the end date)
  private async runRecurring(ctx: WriteContext, recurUID: number, today: string, requireActive: boolean) {
    return this.db.write.transaction(async (trx) => {
      const journal = await this.repo.recurring(ctx.orgUID, recurUID, trx);
      if (!journal) throw new CiValidationError("Recurring journal not found.");
      if (requireActive && Number(journal.IsActive) !== 1) throw new CiValidationError("This recurring journal is paused.");
      const raw = (journal.Lines as Row[]).map((l) => ({ LedgerUID: l.LedgerUID, Type: l.TransactionType, Amount: l.Amount, Particulars: l.Particulars }));
      if (raw.length === 0) throw new CiValidationError("Recurring journal has no lines configured.");
      const lines = await this.journalLines(ctx.orgUID, raw, true).catch((err: Error) => {
        throw new CiValidationError(err.message === "Journal is not balanced. Debit total must equal credit total." ? "Recurring journal lines are not balanced." : err.message);
      });

      const posted = await this.journal.postManual(trx, ctx.orgUID, today, String(journal.Narration), lines, ctx.userUID, "Recurring");
      const next = advanceRunDate(String(journal.NextRunDate), String(journal.Frequency));
      const ended = !!journal.EndDate && next > String(journal.EndDate);
      await this.repo.updateRecurring(ctx.orgUID, recurUID, {
        LastRunDate: today,
        NextRunDate: next,
        TotalRuns: Number(journal.TotalRuns ?? 0) + 1,
        IsActive: ended ? 0 : Number(journal.IsActive),
        UpdatedBy: ctx.userUID,
      }, trx);
      return { journalUID: posted.journalUID, next, ended, title: String(journal.Title) };
    });
  }

  // postRecurringJournal — run one now
  async postRecurring(ctx: WriteContext, recurUID: number) {
    if (!recurUID) throw new CiValidationError("Invalid recurring journal.");
    const run = await this.runRecurring(ctx, recurUID, await this.today(ctx.orgUID), true);
    return { Message: "Journal posted successfully.", JournalUID: run.journalUID, NextRunDate: run.next, Ended: run.ended };
  }

  // postAllDueJournals — each due journal once; one failing does not stop the others
  async postAllDue(ctx: WriteContext) {
    const today = await this.today(ctx.orgUID);
    const due = await this.repo.dueRecurringUIDs(ctx.orgUID, today);
    if (due.length === 0) return { Message: "No journals are due.", Posted: 0, Errors: [] as string[] };
    let posted = 0;
    const errors: string[] = [];
    for (const row of due) {
      try {
        await this.runRecurring(ctx, Number(row.RecurUID), today, true);
        posted++;
      } catch (err) {
        errors.push(`${row.Title}: ${(err as Error).message}`);
      }
    }
    const message = `${posted} journal(s) posted.` + (errors.length ? ` Errors: ${errors.join("; ")}` : "");
    if (posted === 0 && errors.length) throw new CiValidationError(message, { Posted: 0, Errors: errors });
    return { Message: message, Posted: posted, Errors: errors };
  }

  // toggleRecurringStatus — pause / resume
  async toggleRecurring(ctx: WriteContext, recurUID: number) {
    if (!recurUID) throw new CiValidationError("Invalid recurring journal.");
    const journal = await this.repo.recurring(ctx.orgUID, recurUID);
    if (!journal) throw new CiValidationError("Recurring journal not found.");
    const status = Number(journal.IsActive) === 1 ? 0 : 1;
    await this.repo.updateRecurring(ctx.orgUID, recurUID, { IsActive: status, UpdatedBy: ctx.userUID });
    return { Message: status ? "Recurring journal resumed." : "Recurring journal paused.", IsActive: status };
  }

  // deleteRecurringJournal
  async deleteRecurring(ctx: WriteContext, recurUID: number) {
    if (!recurUID) throw new CiValidationError("Invalid recurring journal.");
    if (!(await this.repo.updateRecurring(ctx.orgUID, recurUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID }))) throw new CiValidationError("Recurring journal not found.");
    return { Message: "Recurring journal deleted." };
  }

  // ── Period lock ───────────────────────────────────────────────────────────

  // periodlock
  async periodLock(orgUID: number) {
    return { CurrentLock: await this.repo.periodLock(orgUID) };
  }

  // savePeriodLock — set or move the lock date
  async savePeriodLock(ctx: WriteContext, rawDate: unknown) {
    const lockDate = String(rawDate ?? "").trim();
    if (!isIsoDate(lockDate)) throw new CiValidationError("A valid lock date is required.");
    const tz = (await this.orgSettings.get(ctx.orgUID)).Timezone;
    await this.repo.savePeriodLock(ctx.orgUID, lockDate, ctx.userUID, nowIn(tz));
    const display = phpDate(await this.repo.listDateFormat(ctx.orgUID), new Date(`${lockDate}T00:00:00Z`), "UTC");
    return { Message: `Books locked up to ${display}.`, LockedUpTo: lockDate };
  }

  // removePeriodLock
  async removePeriodLock(ctx: WriteContext) {
    await this.repo.removePeriodLock(ctx.orgUID);
    return { Message: "Period lock removed. All periods are now open for posting." };
  }

  // ── Budgets ───────────────────────────────────────────────────────────────

  // saveBudgetAmount — the annual budget of one of the organisation's income / expense ledgers
  async saveBudget(ctx: WriteContext, form: Form) {
    const ledgerUID = postInt(form, "LedgerUID");
    const fy = postInt(form, "FY");
    const amount = num(form.Amount);
    if (!ledgerUID || !fy) throw new CiValidationError("Invalid parameters.");
    if (amount < 0) throw new CiValidationError("Budget amount cannot be negative.");
    const ledger = await this.repo.ledger(ctx.orgUID, ledgerUID);
    if (!ledger || !["Income", "Expense"].includes(String(ledger.LedgerType))) throw new CiValidationError("Ledger not found.");
    const tz = (await this.orgSettings.get(ctx.orgUID)).Timezone;
    await this.repo.saveBudget(ctx.orgUID, ledgerUID, fy, amount, ctx.userUID, nowIn(tz));
    return { Amount: amount };
  }
}
