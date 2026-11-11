import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;
export type Filter = Record<string, string>;

const COA = "Accounting.ChartOfAccounts";
const GJ = "Accounting.GeneralJournal";
const JE = "Accounting.JournalEntries";
const RECUR = "Accounting.RecurringJournals";
const RECUR_LINES = "Accounting.RecurringJournalLines";

const LEDGER_COLUMNS = [
  "LedgerUID", "OrgUID", "LedgerCode", "LedgerName", "LedgerType", "ParentLedgerUID",
  "OpeningBalance", "OpeningBalanceType", "CurrentBalance", "CurrentBalanceType", "IsActive", "IsDeleted",
];
const RECUR_COLUMNS = [
  "RecurUID", "OrgUID", "Title", "Narration", "Frequency", "StartDate", "EndDate", "NextRunDate", "LastRunDate",
  "TotalRuns", "IsActive", "IsDeleted", "CreatedBy", "CreatedOn", "UpdatedBy", "UpdatedOn",
];
const BS_TYPES = ["Asset", "Liability", "Bank", "Cash", "Customer", "Vendor", "Employee"];

/**
 * Balances leave out reversal journals: a reversal is only posted when its original journal is soft-deleted
 * (reverseJournal / reverseManualJournal), and deleted journals are left out, so counting the reversal alone
 * would undo the record twice (CI3 showed a deleted ₹1,000 invoice as −₹1,000). Registers (journal list,
 * day book) still list them.
 */
const NOT_REVERSAL = "COALESCE(gj.ReferenceType, '') NOT LIKE 'Reversal-%'";

/**
 * Accountledger_model — Chart of Accounts, journals and the accounting reports. Every query is limited to the
 * organisation. Journal totals only count entries whose journal matched the report's filter: CI3 summed
 * je.Amount after a LEFT JOIN on the filtered journal, so entries outside the year / date range / as-of date
 * (and deleted journals) were counted too.
 */
@Injectable()
export class AccountingRepository extends BaseRepository {
  private reconColumn?: Promise<boolean>;

  constructor(db: DatabaseService) {
    super(db);
  }

  // SUM of one side, only for entries whose journal passed the join's filter
  private side(type: "Debit" | "Credit", alias: string, extra = "", bindings: Knex.Value[] = []): Knex.Raw {
    return this.read.raw(
      `IFNULL(SUM(CASE WHEN gj.JournalUID IS NOT NULL AND je.TransactionType = '${type}'${extra ? ` AND ${extra}` : ""} THEN je.Amount ELSE 0 END), 0) AS ??`,
      [...bindings, alias]
    );
  }

  private static dateOnly(k: Knex, column: string, alias = column.split(".").pop() as string): Knex.Raw {
    return k.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", [column, alias]);
  }

  // Ledgers joined to their live entries and the journals that pass `journalFilter`
  private ledgerTotals(orgUID: number, journalFilter: (on: Knex.JoinClause) => void): Knex.QueryBuilder {
    return this.read(`${COA} as ca`)
      .leftJoin(`${JE} as je`, (on) => on.on("je.LedgerUID", "ca.LedgerUID").andOnVal("je.IsDeleted", "=", 0).andOnVal("je.OrgUID", "=", orgUID))
      .leftJoin(`${GJ} as gj`, (on) => {
        on.on("gj.JournalUID", "je.JournalUID").andOnVal("gj.IsDeleted", "=", 0).andOnVal("gj.OrgUID", "=", orgUID).andOn(this.read.raw(NOT_REVERSAL));
        journalFilter(on);
      })
      .where({ "ca.OrgUID": orgUID, "ca.IsDeleted": 0 })
      .groupBy("ca.LedgerUID");
  }

  // ── Chart of Accounts ─────────────────────────────────────────────────────

  private chartBase(orgUID: number, filter: Filter): Knex.QueryBuilder {
    const qb = this.read(`${COA} as ca`).where({ "ca.OrgUID": orgUID, "ca.IsDeleted": 0 });
    if (filter.LedgerType) qb.where("ca.LedgerType", filter.LedgerType);
    if (filter.SearchAllData) this.whereAnyLike(qb, ["ca.LedgerCode", "ca.LedgerName"], filter.SearchAllData);
    return qb;
  }

  // getChartOfAccountsList
  chartList(orgUID: number, filter: Filter, limit: number, offset: number): Promise<Row[]> {
    return this.chartBase(orgUID, filter)
      .leftJoin(`${COA} as p`, "p.LedgerUID", "ca.ParentLedgerUID")
      .select(
        "ca.LedgerUID", "ca.LedgerCode", "ca.LedgerName", "ca.LedgerType", "ca.OpeningBalance", "ca.OpeningBalanceType",
        "ca.CurrentBalance", "ca.CurrentBalanceType", "ca.IsActive", "ca.IsDeleted", "ca.ParentLedgerUID", "p.LedgerName as ParentLedgerName"
      )
      .orderBy([{ column: "ca.LedgerType", order: "asc" }, { column: "ca.LedgerName", order: "asc" }])
      .limit(limit)
      .offset(offset);
  }

  // getChartOfAccountsCount
  async chartCount(orgUID: number, filter: Filter): Promise<number> {
    const row = await this.chartBase(orgUID, filter).count({ cnt: "*" }).first();
    return Number(row?.cnt ?? 0);
  }

  // getChartOfAccountsStats
  async chartStats(orgUID: number): Promise<Row> {
    const row = await this.read(COA)
      .select(
        this.read.raw("COUNT(*) AS TotalCount"),
        this.read.raw("IFNULL(SUM(LedgerType = 'Asset'), 0) AS AssetCount"),
        this.read.raw("IFNULL(SUM(LedgerType = 'Liability'), 0) AS LiabilityCount"),
        this.read.raw("IFNULL(SUM(LedgerType = 'Income'), 0) AS IncomeCount"),
        this.read.raw("IFNULL(SUM(LedgerType = 'Expense'), 0) AS ExpenseCount"),
        this.read.raw("IFNULL(SUM(LedgerType IN ('Customer','Vendor','Employee','Bank','Cash')), 0) AS OtherCount")
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? {};
  }

  // getParentLedgers / getAllActiveLedgers / getLedgersForJournalDropdown — the organisation's active ledgers
  activeLedgers(orgUID: number, search = "", limit = 0, types: string[] = []): Promise<Row[]> {
    const qb = this.read(COA)
      .select("LedgerUID", "LedgerCode", "LedgerName", "LedgerType", "OpeningBalance", "OpeningBalanceType")
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy([{ column: "LedgerType", order: "asc" }, { column: "LedgerName", order: "asc" }]);
    if (types.length) qb.whereIn("LedgerType", types);
    if (search) this.whereAnyLike(qb, ["LedgerCode", "LedgerName"], search);
    if (limit > 0) qb.limit(limit);
    return qb;
  }

  // getLedgerById — the organisation's ledger (not deleted)
  async ledger(orgUID: number, ledgerUID: number): Promise<Row | null> {
    const row = await this.read(COA).select(LEDGER_COLUMNS).where({ LedgerUID: ledgerUID, OrgUID: orgUID, IsDeleted: 0 }).first();
    return (row as Row | undefined) ?? null;
  }

  // Which of these ledgers are the organisation's live ledgers
  async orgLedgerUIDs(orgUID: number, ledgerUIDs: number[], activeOnly = false): Promise<Set<number>> {
    if (ledgerUIDs.length === 0) return new Set();
    const qb = this.read(COA).select("LedgerUID").where({ OrgUID: orgUID, IsDeleted: 0 }).whereIn("LedgerUID", ledgerUIDs);
    if (activeOnly) qb.where("IsActive", 1);
    return new Set((await qb).map((r: Row) => Number(r.LedgerUID)));
  }

  async ledgerCodeTaken(orgUID: number, code: string): Promise<boolean> {
    return !!(await this.read(COA).select("LedgerUID").where({ OrgUID: orgUID, LedgerCode: code }).first());
  }

  // ledgerHasTransactions
  async ledgerHasEntries(orgUID: number, ledgerUID: number): Promise<boolean> {
    return !!(await this.read(JE).select("EntryUID").where({ LedgerUID: ledgerUID, OrgUID: orgUID, IsDeleted: 0 }).first());
  }

  async insertLedger(row: Row): Promise<number> {
    const [id] = await this.writer()(COA).insert(row);
    return Number(id);
  }

  // Only the organisation's live ledger is changed; returns the rows changed
  updateLedger(orgUID: number, ledgerUID: number, data: Row): Promise<number> {
    return this.writer()(COA).where({ LedgerUID: ledgerUID, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  // ── Journals ──────────────────────────────────────────────────────────────

  // getJournalFinancialYears
  async journalYears(orgUID: number): Promise<number[]> {
    const rows = await this.read(GJ).distinct("FinancialYear").where({ OrgUID: orgUID, IsDeleted: 0 }).orderBy("FinancialYear", "desc");
    return rows.map((r: Row) => Number(r.FinancialYear));
  }

  // getTrialBalance — every live ledger with its debits / credits in the financial year
  trialBalance(orgUID: number, fy: number): Promise<Row[]> {
    return this.ledgerTotals(orgUID, (on) => on.andOnVal("gj.FinancialYear", "=", fy))
      .select("ca.LedgerUID", "ca.LedgerCode", "ca.LedgerName", "ca.LedgerType", "ca.OpeningBalance", "ca.OpeningBalanceType", this.side("Debit", "PeriodDebit"), this.side("Credit", "PeriodCredit"))
      .orderBy([{ column: "ca.LedgerType", order: "asc" }, { column: "ca.LedgerName", order: "asc" }]);
  }

  private journalBase(orgUID: number, filter: Filter): Knex.QueryBuilder {
    const qb = this.read(`${GJ} as gj`).where({ "gj.OrgUID": orgUID, "gj.IsDeleted": 0 });
    if (filter.ReferenceType) qb.where("gj.ReferenceType", filter.ReferenceType);
    if (filter.DateFrom) qb.where("gj.JournalDate", ">=", filter.DateFrom);
    if (filter.DateTo) qb.where("gj.JournalDate", "<=", filter.DateTo);
    if (filter.SearchAllData) this.whereAnyLike(qb, ["gj.JournalNo", "gj.ReferenceNo", "gj.Narration"], filter.SearchAllData);
    return qb;
  }

  // getJournalList
  journalList(orgUID: number, filter: Filter, limit: number, offset: number): Promise<Row[]> {
    const k = this.read;
    return this.journalBase(orgUID, filter)
      .leftJoin(`${JE} as je`, (on) => on.on("je.JournalUID", "gj.JournalUID").andOnVal("je.IsDeleted", "=", 0))
      .select(
        "gj.JournalUID", "gj.JournalNo", AccountingRepository.dateOnly(k, "gj.JournalDate"), "gj.FinancialYear", "gj.ReferenceType", "gj.ReferenceID",
        "gj.ReferenceNo", "gj.Narration", "gj.CreatedBy", "gj.CreatedOn",
        k.raw("IFNULL(SUM(CASE WHEN je.TransactionType = 'Debit' THEN je.Amount ELSE 0 END), 0) AS TotalDebit"),
        k.raw("IFNULL(SUM(CASE WHEN je.TransactionType = 'Credit' THEN je.Amount ELSE 0 END), 0) AS TotalCredit"),
        k.raw("COUNT(je.EntryUID) AS LineCount")
      )
      .groupBy("gj.JournalUID")
      .orderBy([{ column: "gj.JournalDate", order: "desc" }, { column: "gj.JournalUID", order: "desc" }])
      .limit(limit)
      .offset(offset);
  }

  // getJournalCount
  async journalCount(orgUID: number, filter: Filter): Promise<number> {
    const row = await this.journalBase(orgUID, filter).count({ cnt: "*" }).first();
    return Number(row?.cnt ?? 0);
  }

  // getJournalStats
  async journalStats(orgUID: number): Promise<Row> {
    const k = this.read;
    const row = await k(GJ)
      .select(
        k.raw("COUNT(*) AS TotalCount"),
        k.raw("IFNULL(SUM(ReferenceType = 'Invoice'), 0) AS InvoiceCount"),
        k.raw("IFNULL(SUM(ReferenceType = 'Purchase'), 0) AS PurchaseCount"),
        k.raw("IFNULL(SUM(ReferenceType LIKE 'Payment%'), 0) AS PaymentCount"),
        k.raw("IFNULL(SUM(ReferenceType LIKE 'Reversal%'), 0) AS ReversalCount"),
        k.raw("IFNULL(SUM(ReferenceType = 'Manual'), 0) AS ManualCount"),
        k.raw("IFNULL(SUM(ReferenceType NOT IN ('Invoice','Purchase','Manual') AND ReferenceType NOT LIKE 'Payment%' AND ReferenceType NOT LIKE 'Reversal%'), 0) AS OtherCount")
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? {};
  }

  // getJournalWithEntries — the organisation's journal (deleted ones too, as CI3) and its live lines
  async journalWithEntries(orgUID: number, journalUID: number): Promise<Row | null> {
    const k = this.read;
    const header = await k(GJ)
      .select(
        "JournalUID", "OrgUID", "JournalNo", AccountingRepository.dateOnly(k, "JournalDate"), "FinancialYear", "ReferenceType", "ReferenceID",
        "ReferenceNo", "Narration", k.raw("CAST(?? AS UNSIGNED) AS ??", ["IsDeleted", "IsDeleted"]), "CreatedBy", "CreatedOn", "UpdatedOn"
      )
      .where({ JournalUID: journalUID, OrgUID: orgUID })
      .first();
    if (!header) return null;
    const lines = await k(`${JE} as je`)
      .leftJoin(`${COA} as ca`, "ca.LedgerUID", "je.LedgerUID")
      .select("je.EntryUID", "je.LedgerUID", "je.TransactionType", "je.Amount", "je.Particulars", "ca.LedgerCode", "ca.LedgerName", "ca.LedgerType")
      .where({ "je.JournalUID": journalUID, "je.OrgUID": orgUID, "je.IsDeleted": 0 })
      .orderBy("je.EntryUID", "asc");
    return { ...(header as Row), Lines: lines };
  }

  // getLedgerStatement — the ledger's live entries in the date range, oldest first
  ledgerStatement(orgUID: number, ledgerUID: number, dateFrom: string | null, dateTo: string | null, withRecon = false): Promise<Row[]> {
    const k = this.read;
    const qb = k(`${JE} as je`)
      .join(`${GJ} as gj`, (on) => on.on("gj.JournalUID", "je.JournalUID").andOnVal("gj.IsDeleted", "=", 0).andOn(k.raw(NOT_REVERSAL)))
      .select(
        "je.EntryUID", "gj.JournalUID", "gj.JournalNo", AccountingRepository.dateOnly(k, "gj.JournalDate"), "gj.ReferenceType", "gj.ReferenceNo", "gj.Narration",
        "je.TransactionType", "je.Amount", "je.Particulars",
        withRecon ? k.raw("CAST(?? AS UNSIGNED) AS ??", ["je.IsReconciled", "IsReconciled"]) : k.raw("0 AS IsReconciled")
      )
      .where({ "je.LedgerUID": ledgerUID, "je.OrgUID": orgUID, "je.IsDeleted": 0 })
      .orderBy([{ column: "gj.JournalDate", order: "asc" }, { column: "gj.JournalUID", order: "asc" }, { column: "je.EntryUID", order: "asc" }]);
    if (dateFrom) qb.where("gj.JournalDate", ">=", dateFrom);
    if (dateTo) qb.where("gj.JournalDate", "<=", dateTo);
    return qb;
  }

  // getLedgerActivityBefore — debits / credits before a date (for the opening balance)
  async activityBefore(orgUID: number, ledgerUID: number, dateBefore: string): Promise<{ debit: number; credit: number }> {
    const k = this.read;
    const row = await k(`${JE} as je`)
      .join(`${GJ} as gj`, (on) => on.on("gj.JournalUID", "je.JournalUID").andOnVal("gj.IsDeleted", "=", 0).andOn(k.raw(NOT_REVERSAL)))
      .select(
        k.raw("IFNULL(SUM(CASE WHEN je.TransactionType = 'Debit' THEN je.Amount ELSE 0 END), 0) AS TotalDebit"),
        k.raw("IFNULL(SUM(CASE WHEN je.TransactionType = 'Credit' THEN je.Amount ELSE 0 END), 0) AS TotalCredit")
      )
      .where({ "je.LedgerUID": ledgerUID, "je.OrgUID": orgUID, "je.IsDeleted": 0 })
      .where("gj.JournalDate", "<", dateBefore)
      .first();
    return { debit: Number(row?.TotalDebit ?? 0), credit: Number(row?.TotalCredit ?? 0) };
  }

  // ── Bank reconciliation ───────────────────────────────────────────────────

  // CI3 reads and writes JournalEntries.IsReconciled, which no migration creates
  hasReconColumn(): Promise<boolean> {
    this.reconColumn ??= this.read("information_schema.COLUMNS")
      .select("COLUMN_NAME")
      .where({ TABLE_SCHEMA: "Accounting", TABLE_NAME: "JournalEntries", COLUMN_NAME: "IsReconciled" })
      .first()
      .then((row) => !!row);
    return this.reconColumn;
  }

  // bulkUpdateReconStatus — only the organisation's entries on its bank / cash ledgers
  async setReconciled(orgUID: number, entryUIDs: number[], reconciled: 0 | 1): Promise<number> {
    if (entryUIDs.length === 0) return 0;
    return this.writer()(JE)
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .whereIn("EntryUID", entryUIDs)
      .whereIn("LedgerUID", this.read(COA).select("LedgerUID").where({ OrgUID: orgUID }).whereIn("LedgerType", ["Bank", "Cash"]))
      .update({ IsReconciled: reconciled });
  }

  // ── Recurring journals ────────────────────────────────────────────────────

  private recurringBase(orgUID: number, filter: Filter, today: string): Knex.QueryBuilder {
    const qb = this.read(RECUR).where({ OrgUID: orgUID, IsDeleted: 0 });
    if (filter.IsActive !== undefined && filter.IsActive !== "") qb.where("IsActive", Number(filter.IsActive) ? 1 : 0);
    if (filter.Due && filter.Due !== "0") qb.where("NextRunDate", "<=", today).where("IsActive", 1);
    if (filter.SearchAllData) this.whereAnyLike(qb, ["Title", "Narration"], filter.SearchAllData);
    return qb;
  }

  private recurringColumns(): (string | Knex.Raw)[] {
    const k = this.read;
    return RECUR_COLUMNS.map((c) => (["StartDate", "EndDate", "NextRunDate", "LastRunDate"].includes(c) ? AccountingRepository.dateOnly(k, c) : c));
  }

  // getRecurringJournalList
  recurringList(orgUID: number, filter: Filter, today: string, limit: number, offset: number): Promise<Row[]> {
    return this.recurringBase(orgUID, filter, today)
      .select(this.recurringColumns())
      .orderBy([{ column: "IsActive", order: "desc" }, { column: "NextRunDate", order: "asc" }])
      .limit(limit)
      .offset(offset);
  }

  // getRecurringJournalCount
  async recurringCount(orgUID: number, filter: Filter, today: string): Promise<number> {
    const row = await this.recurringBase(orgUID, filter, today).count({ cnt: "*" }).first();
    return Number(row?.cnt ?? 0);
  }

  // getRecurringJournalStats
  async recurringStats(orgUID: number, today: string): Promise<Row> {
    const k = this.read;
    const row = await k(RECUR)
      .select(
        k.raw("COUNT(*) AS TotalCount"),
        k.raw("IFNULL(SUM(IsActive = 1), 0) AS ActiveCount"),
        k.raw("IFNULL(SUM(IsActive = 0), 0) AS PausedCount"),
        k.raw("IFNULL(SUM(IsActive = 1 AND NextRunDate <= ?), 0) AS DueCount", [today])
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? {};
  }

  // getRecurringJournalById — the header and its lines with ledger names
  async recurring(orgUID: number, recurUID: number, trx?: Knex.Transaction): Promise<Row | null> {
    const k = trx ?? this.read;
    const qb = k(RECUR).select(this.recurringColumns()).where({ RecurUID: recurUID, OrgUID: orgUID, IsDeleted: 0 });
    if (trx) qb.forUpdate();
    const header = await qb.first();
    if (!header) return null;
    const lines = await k(`${RECUR_LINES} as rjl`)
      .leftJoin(`${COA} as ca`, "ca.LedgerUID", "rjl.LedgerUID")
      .select("rjl.LineUID", "rjl.RecurUID", "rjl.LedgerUID", "rjl.TransactionType", "rjl.Amount", "rjl.Particulars", "rjl.SortOrder", "ca.LedgerName", "ca.LedgerCode", "ca.LedgerType")
      .where({ "rjl.RecurUID": recurUID, "rjl.OrgUID": orgUID })
      .orderBy([{ column: "rjl.SortOrder", order: "asc" }, { column: "rjl.LineUID", order: "asc" }]);
    return { ...(header as Row), Lines: lines };
  }

  // getDueRecurringJournals
  async dueRecurringUIDs(orgUID: number, today: string): Promise<Row[]> {
    return this.read(RECUR).select("RecurUID", "Title").where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 }).where("NextRunDate", "<=", today).orderBy("NextRunDate", "asc");
  }

  async insertRecurring(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx(RECUR).insert(row);
    return Number(id);
  }

  updateRecurring(orgUID: number, recurUID: number, data: Row, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? this.writer())(RECUR).where({ RecurUID: recurUID, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  async replaceRecurringLines(trx: Knex.Transaction, orgUID: number, recurUID: number, lines: Row[]): Promise<void> {
    await trx(RECUR_LINES).where({ RecurUID: recurUID, OrgUID: orgUID }).del();
    if (lines.length) await trx(RECUR_LINES).insert(lines);
  }

  // ── Statements ────────────────────────────────────────────────────────────

  // getPandLRows — active income / expense ledgers with their movement in the date range
  pnlRows(orgUID: number, dateFrom: string, dateTo: string): Promise<Row[]> {
    return this.ledgerTotals(orgUID, (on) => on.andOnVal("gj.JournalDate", ">=", dateFrom).andOnVal("gj.JournalDate", "<=", dateTo))
      .select("ca.LedgerUID", "ca.LedgerCode", "ca.LedgerName", "ca.LedgerType", this.side("Debit", "PeriodDebit"), this.side("Credit", "PeriodCredit"))
      .whereIn("ca.LedgerType", ["Income", "Expense"])
      .where("ca.IsActive", 1)
      .orderBy([{ column: "ca.LedgerType", order: "asc" }, { column: "ca.LedgerName", order: "asc" }]);
  }

  // getBalanceSheetRows — balance-sheet ledgers with their movement up to the date
  balanceSheetRows(orgUID: number, asOfDate: string): Promise<Row[]> {
    return this.ledgerTotals(orgUID, (on) => on.andOnVal("gj.JournalDate", "<=", asOfDate))
      .select("ca.LedgerUID", "ca.LedgerCode", "ca.LedgerName", "ca.LedgerType", "ca.OpeningBalance", "ca.OpeningBalanceType", this.side("Debit", "PeriodDebit"), this.side("Credit", "PeriodCredit"))
      .whereIn("ca.LedgerType", BS_TYPES)
      .orderBy([{ column: "ca.LedgerType", order: "asc" }, { column: "ca.LedgerName", order: "asc" }]);
  }

  // getCashFlowBalances — bank / cash ledgers: movement before and within the range (Cash first)
  cashFlowBalances(orgUID: number, dateFrom: string, dateTo: string): Promise<Row[]> {
    return this.ledgerTotals(orgUID, () => undefined)
      .select(
        "ca.LedgerUID", "ca.LedgerName", "ca.LedgerType", "ca.OpeningBalance", "ca.OpeningBalanceType",
        this.side("Debit", "PreDr", "gj.JournalDate < ?", [dateFrom]),
        this.side("Credit", "PreCr", "gj.JournalDate < ?", [dateFrom]),
        this.side("Debit", "PeriodDr", "gj.JournalDate >= ? AND gj.JournalDate <= ?", [dateFrom, dateTo]),
        this.side("Credit", "PeriodCr", "gj.JournalDate >= ? AND gj.JournalDate <= ?", [dateFrom, dateTo])
      )
      .whereIn("ca.LedgerType", ["Bank", "Cash"])
      .orderBy([{ column: "ca.LedgerType", order: "desc" }, { column: "ca.LedgerName", order: "asc" }]);
  }

  // getCashFlowCategoryRows — bank / cash movement in the range by journal type and side
  cashFlowCategories(orgUID: number, dateFrom: string, dateTo: string): Promise<Row[]> {
    const k = this.read;
    return k(`${JE} as je`)
      .join(`${COA} as ca`, (on) => on.on("ca.LedgerUID", "je.LedgerUID").andOnVal("ca.IsDeleted", "=", 0))
      .join(`${GJ} as gj`, (on) => on.on("gj.JournalUID", "je.JournalUID").andOnVal("gj.IsDeleted", "=", 0).andOnVal("gj.OrgUID", "=", orgUID).andOn(k.raw(NOT_REVERSAL)))
      .select("je.LedgerUID as CashLedgerUID", "gj.ReferenceType", "je.TransactionType", k.raw("SUM(je.Amount) AS Total"))
      .whereIn("ca.LedgerType", ["Bank", "Cash"])
      .where({ "ca.OrgUID": orgUID, "je.IsDeleted": 0 })
      .where("gj.JournalDate", ">=", dateFrom)
      .where("gj.JournalDate", "<=", dateTo)
      .groupBy(["je.LedgerUID", "gj.ReferenceType", "je.TransactionType"]);
  }

  // getBudgetVsActualRows — active income / expense ledgers, the year's annual budget and the range's movement
  budgetRows(orgUID: number, fy: number, dateFrom: string, dateTo: string): Promise<Row[]> {
    return this.ledgerTotals(orgUID, (on) => on.andOnVal("gj.JournalDate", ">=", dateFrom).andOnVal("gj.JournalDate", "<=", dateTo))
      .leftJoin("Accounting.Budgets as b", (on) =>
        on.on("b.LedgerUID", "ca.LedgerUID").andOnVal("b.OrgUID", "=", orgUID).andOnVal("b.FinancialYear", "=", fy).andOnVal("b.Month", "=", 0).andOnVal("b.IsDeleted", "=", 0)
      )
      .select(
        "ca.LedgerUID", "ca.LedgerCode", "ca.LedgerName", "ca.LedgerType", this.read.raw("IFNULL(MAX(b.BudgetedAmount), 0) AS BudgetedAmount"),
        this.side("Debit", "PeriodDr"), this.side("Credit", "PeriodCr")
      )
      .whereIn("ca.LedgerType", ["Income", "Expense"])
      .where("ca.IsActive", 1)
      .orderBy([{ column: "ca.LedgerType", order: "asc" }, { column: "ca.LedgerName", order: "asc" }]);
  }

  // saveBudgetAmount — the ledger's annual budget (Month 0), revived when it was deleted
  async saveBudget(orgUID: number, ledgerUID: number, fy: number, amount: number, userUID: number, now: string): Promise<void> {
    await this.writer()("Accounting.Budgets")
      .insert({ OrgUID: orgUID, LedgerUID: ledgerUID, FinancialYear: fy, Month: 0, BudgetedAmount: amount, CreatedBy: userUID, CreatedAt: now, IsDeleted: 0 })
      .onConflict(["OrgUID", "LedgerUID", "FinancialYear", "Month"])
      .merge({ BudgetedAmount: amount, UpdatedBy: userUID, UpdatedAt: now, IsDeleted: 0 });
  }

  /**
   * getAgedReceivablesRows / getAgedPayablesRows — customer (Debit side) or vendor (Credit side) ledgers with their
   * totals up to the date and the `side` amounts split into 0-30 / 31-60 / 61-90 / 90+ day bands.
   */
  agedRows(orgUID: number, ledgerType: "Customer" | "Vendor", asOfDate: string, bands: { d30: string; d60: string; d90: string }): Promise<Row[]> {
    const s = ledgerType === "Customer" ? "Debit" : "Credit";
    const p = ledgerType === "Customer" ? "Dr" : "Cr";
    return this.ledgerTotals(orgUID, (on) => on.andOnVal("gj.JournalDate", "<=", asOfDate))
      .select(
        "ca.LedgerUID", "ca.LedgerCode", "ca.LedgerName", "ca.OpeningBalance", "ca.OpeningBalanceType",
        this.side("Debit", "TotalDr"), this.side("Credit", "TotalCr"),
        this.side(s, `${p}Band0_30`, "gj.JournalDate >= ?", [bands.d30]),
        this.side(s, `${p}Band31_60`, "gj.JournalDate >= ? AND gj.JournalDate < ?", [bands.d60, bands.d30]),
        this.side(s, `${p}Band61_90`, "gj.JournalDate >= ? AND gj.JournalDate < ?", [bands.d90, bands.d60]),
        this.side(s, `${p}Band90plus`, "gj.JournalDate < ?", [bands.d90])
      )
      .where("ca.LedgerType", ledgerType)
      .orderBy("ca.LedgerName", "asc");
  }

  // getDayBookRows — every live entry in the range (one ledger, or bank / cash only), by date and journal
  dayBookRows(orgUID: number, dateFrom: string, dateTo: string, cashBankOnly: boolean, ledgerUID: number): Promise<Row[]> {
    const k = this.read;
    const qb = k(`${GJ} as gj`)
      .join(`${JE} as je`, (on) => on.on("je.JournalUID", "gj.JournalUID").andOnVal("je.IsDeleted", "=", 0))
      .join(`${COA} as ca`, (on) => on.on("ca.LedgerUID", "je.LedgerUID").andOnVal("ca.IsDeleted", "=", 0))
      .select(
        AccountingRepository.dateOnly(k, "gj.JournalDate"), "gj.JournalUID", "gj.JournalNo", "gj.ReferenceType", "gj.ReferenceNo", "gj.Narration",
        "ca.LedgerUID", "ca.LedgerName", "ca.LedgerType", "ca.LedgerCode", "je.EntryUID", "je.TransactionType", "je.Amount", "je.Particulars"
      )
      .where({ "gj.OrgUID": orgUID, "gj.IsDeleted": 0 })
      .where("gj.JournalDate", ">=", dateFrom)
      .where("gj.JournalDate", "<=", dateTo)
      .orderBy([{ column: "gj.JournalDate", order: "asc" }, { column: "gj.JournalUID", order: "asc" }])
      .orderByRaw("FIELD(je.TransactionType, 'Debit', 'Credit')");
    if (ledgerUID > 0) qb.where("ca.LedgerUID", ledgerUID);
    else if (cashBankOnly) qb.whereIn("ca.LedgerType", ["Bank", "Cash"]);
    return qb;
  }

  // GenSettings->ListDateFormat (CI3 default 'd M Y')
  async listDateFormat(orgUID: number): Promise<string> {
    const row = await this.read("Settings.OrgSettingsTbl").select("ListDateFormat").where({ OrgUID: orgUID }).first();
    return row?.ListDateFormat || "d M Y";
  }

  // ── Period lock ───────────────────────────────────────────────────────────

  // getPeriodLock
  async periodLock(orgUID: number): Promise<Row | null> {
    const k = this.read;
    const row = await k("Accounting.PeriodLock")
      .select("LockUID", "OrgUID", AccountingRepository.dateOnly(k, "LockedUpTo"), "LockedBy", "LockedOn", "UpdatedBy", "UpdatedOn")
      .where({ OrgUID: orgUID })
      .first();
    return (row as Row | undefined) ?? null;
  }

  // One lock per organisation (uq_org)
  async savePeriodLock(orgUID: number, lockedUpTo: string, userUID: number, now: string): Promise<void> {
    await this.writer()("Accounting.PeriodLock")
      .insert({ OrgUID: orgUID, LockedUpTo: lockedUpTo, LockedBy: userUID, LockedOn: now })
      .onConflict(["OrgUID"])
      .merge({ LockedUpTo: lockedUpTo, UpdatedBy: userUID });
  }

  async removePeriodLock(orgUID: number): Promise<void> {
    await this.writer()("Accounting.PeriodLock").where({ OrgUID: orgUID }).del();
  }
}
