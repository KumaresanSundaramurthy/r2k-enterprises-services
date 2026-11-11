import { Injectable } from "@nestjs/common";
import { escapeHtml } from "../../common/utils/php-compat";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { todayIn } from "../hrms/hrms-common";
import { addDays, calcBalance, num, pct, round, Side, sideOf, toIsoDate } from "./accounting-common";
import { AccountingRepository, Row } from "./accounting.repository";

type Bands = { "0to30": number; "31to60": number; "61to90": number; "90plus": number };

/** CI3 Accounting controller reports, computed the same way; the CI3 views render the returned rows and totals. */
@Injectable()
export class AccountingReportsService {
  constructor(
    private readonly repo: AccountingRepository,
    private readonly orgSettings: OrgSettingsService
  ) {}

  private async today(orgUID: number): Promise<string> {
    return todayIn((await this.orgSettings.get(orgUID)).Timezone);
  }

  // A date the caller sent (null when absent); `label` names it in the error
  private static date(value: unknown, message: string): string {
    const date = toIsoDate(value);
    if (!date) throw new CiValidationError(message);
    return date;
  }

  // P&L totals of income / expense rows (net = credit − debit for income, debit − credit for expense)
  private static pnlTotals(rows: Row[], clampAtZero = false) {
    let income = 0;
    let expense = 0;
    for (const r of rows) {
      const dr = num(r.PeriodDebit);
      const cr = num(r.PeriodCredit);
      if (r.LedgerType === "Income") income += clampAtZero ? Math.max(0, cr - dr) : cr - dr;
      else expense += clampAtZero ? Math.max(0, dr - cr) : dr - cr;
    }
    return { income, expense };
  }

  // ── Trial balance ─────────────────────────────────────────────────────────

  // trialbalance — the years that have journals (this year when none) and the default year
  async trialBalancePageData(orgUID: number) {
    const year = Number((await this.today(orgUID)).slice(0, 4));
    const years = await this.repo.journalYears(orgUID);
    const FinancialYears = years.length ? years : [year];
    return { FinancialYears, DefaultFY: FinancialYears.includes(year) ? year : FinancialYears[0] };
  }

  // getTrialBalanceAjax — each ledger's opening, the year's debits / credits and its closing balance
  async trialBalance(orgUID: number, rawFY: unknown) {
    const fy = Number(rawFY) || Number((await this.today(orgUID)).slice(0, 4));
    const rows = await this.repo.trialBalance(orgUID, fy);
    let grandDr = 0, grandCr = 0, obDr = 0, obCr = 0;
    for (const r of rows) {
      const ob = num(r.OpeningBalance);
      const obType = sideOf(r.OpeningBalanceType);
      const dr = num(r.PeriodDebit);
      const cr = num(r.PeriodCredit);
      [r.ClosingBalance, r.ClosingBalanceType] = calcBalance(ob, obType, dr, cr);
      grandDr += dr;
      grandCr += cr;
      if (obType === "Debit") obDr += ob;
      else obCr += ob;
    }
    return { Rows: rows, FinancialYear: fy, GrandDebit: grandDr, GrandCredit: grandCr, TotalObDr: obDr, TotalObCr: obCr, IsBalanced: Math.abs(grandDr - grandCr) < 0.01, RowCount: rows.length };
  }

  // ── General ledger ────────────────────────────────────────────────────────

  // generalledger — the active ledgers
  async generalLedgerPageData(orgUID: number) {
    return { AllLedgers: await this.repo.activeLedgers(orgUID) };
  }

  // getLedgerStatementAjax — opening balance at DateFrom, the lines with a running balance, and the closing balance
  async ledgerStatement(orgUID: number, ledgerUID: number, rawFrom: unknown, rawTo: unknown) {
    if (!ledgerUID) throw new CiValidationError("Please select a ledger account.");
    const ledger = await this.repo.ledger(orgUID, ledgerUID);
    if (!ledger) throw new CiValidationError("Ledger not found.");
    const dateFrom = toIsoDate(rawFrom);
    const dateTo = toIsoDate(rawTo);

    let [opening, openingType] = [num(ledger.OpeningBalance), sideOf(ledger.OpeningBalanceType)];
    if (dateFrom) {
      const prior = await this.repo.activityBefore(orgUID, ledgerUID, dateFrom);
      [opening, openingType] = calcBalance(opening, openingType, prior.debit, prior.credit);
    }
    const lines = await this.repo.ledgerStatement(orgUID, ledgerUID, dateFrom, dateTo);
    let running: number = opening;
    let runningType: Side = openingType;
    let totalDr = 0, totalCr = 0;
    for (const line of lines) {
      const amount = num(line.Amount);
      if (line.TransactionType === "Debit") {
        totalDr += amount;
        [running, runningType] = calcBalance(running, runningType, amount, 0);
      } else {
        totalCr += amount;
        [running, runningType] = calcBalance(running, runningType, 0, amount);
      }
      line.RunningBalance = running;
      line.RunningBalanceType = runningType;
    }
    return {
      Ledger: ledger, Lines: lines, LedgerName: ledger.LedgerName, DateFrom: dateFrom, DateTo: dateTo,
      OpeningBalance: opening, OpeningType: openingType, ClosingBalance: running, ClosingType: runningType, TotalDebit: totalDr, TotalCredit: totalCr,
    };
  }

  // ── Profit & loss ─────────────────────────────────────────────────────────

  // getPandLAjax — DateFrom defaults to 1 Jan, DateTo to today
  async profitLoss(orgUID: number, rawFrom: unknown, rawTo: unknown) {
    const today = await this.today(orgUID);
    const dateFrom = rawFrom ? AccountingReportsService.date(rawFrom, "Invalid date format.") : `${today.slice(0, 4)}-01-01`;
    const dateTo = rawTo ? AccountingReportsService.date(rawTo, "Invalid date format.") : today;
    if (dateFrom > dateTo) throw new CiValidationError("From date cannot be after To date.");

    const income: Row[] = [];
    const expense: Row[] = [];
    let totalIncome = 0, totalExpense = 0;
    for (const r of await this.repo.pnlRows(orgUID, dateFrom, dateTo)) {
      const dr = num(r.PeriodDebit);
      const cr = num(r.PeriodCredit);
      if (r.LedgerType === "Income") {
        r.NetAmount = cr - dr;
        totalIncome += cr - dr;
        income.push(r);
      } else {
        r.NetAmount = dr - cr;
        totalExpense += dr - cr;
        expense.push(r);
      }
    }
    const byNet = (a: Row, b: Row) => num(b.NetAmount) - num(a.NetAmount);
    income.sort(byNet);
    expense.sort(byNet);
    return { Income: income, Expense: expense, TotalIncome: totalIncome, TotalExpense: totalExpense, NetProfit: totalIncome - totalExpense, DateFrom: dateFrom, DateTo: dateTo };
  }

  // getComparativePnLAjax — two periods side by side, by ledger name
  async comparativePnL(orgUID: number, q: Record<string, unknown>) {
    const msg = "One or more dates are invalid.";
    const p1From = AccountingReportsService.date(q.P1From, msg);
    const p1To = AccountingReportsService.date(q.P1To, msg);
    const p2From = AccountingReportsService.date(q.P2From, msg);
    const p2To = AccountingReportsService.date(q.P2To, msg);
    // CI3: substr(htmlspecialchars(trim(label)), 0, 40) — the views print it as is
    const label = (v: unknown, fallback: string) => escapeHtml(String(v ?? fallback).trim()).slice(0, 40);

    const [rows1, rows2] = await Promise.all([this.repo.pnlRows(orgUID, p1From, p1To), this.repo.pnlRows(orgUID, p2From, p2To)]);
    const p1 = new Map(rows1.map((r) => [Number(r.LedgerUID), r]));
    const p2 = new Map(rows2.map((r) => [Number(r.LedgerUID), r]));
    const income: Row[] = [];
    const expense: Row[] = [];
    for (const uid of new Set([...p1.keys(), ...p2.keys()])) {
      const r1 = p1.get(uid);
      const r2 = p2.get(uid);
      const meta = (r1 ?? r2) as Row;
      const isIncome = meta.LedgerType === "Income";
      const net = (r?: Row) => (r ? (isIncome ? num(r.PeriodCredit) - num(r.PeriodDebit) : num(r.PeriodDebit) - num(r.PeriodCredit)) : 0);
      const net1 = net(r1);
      const net2 = net(r2);
      const item = { LedgerUID: uid, LedgerName: meta.LedgerName, LedgerCode: meta.LedgerCode ?? "", LedgerType: meta.LedgerType, Net1: net1, Net2: net2, Variance: net2 - net1, PctChange: pct(net2 - net1, Math.abs(net1)) };
      (isIncome ? income : expense).push(item);
    }
    const byName = (a: Row, b: Row) => (String(a.LedgerName) < String(b.LedgerName) ? -1 : String(a.LedgerName) > String(b.LedgerName) ? 1 : 0);
    income.sort(byName);
    expense.sort(byName);
    const sum = (rows: Row[], key: string) => rows.reduce((s, r) => s + num(r[key]), 0);
    const inc1 = sum(income, "Net1"), inc2 = sum(income, "Net2"), exp1 = sum(expense, "Net1"), exp2 = sum(expense, "Net2");
    const Totals = {
      income1: inc1, income2: inc2, expense1: exp1, expense2: exp2, net1: inc1 - exp1, net2: inc2 - exp2,
      incVar: inc2 - inc1, expVar: exp2 - exp1, netVar: inc2 - exp2 - (inc1 - exp1),
      incPct: pct(inc2 - inc1, Math.abs(inc1)), expPct: pct(exp2 - exp1, Math.abs(exp1)), netPct: pct(inc2 - exp2 - (inc1 - exp1), Math.abs(inc1 - exp1)),
    };
    return { Income: income, Expense: expense, Totals, P1From: p1From, P1To: p1To, P2From: p2From, P2To: p2To, P1Label: label(q.P1Label, "Period 1"), P2Label: label(q.P2Label, "Period 2") };
  }

  // ── Balance sheet / ratios ────────────────────────────────────────────────

  // getBalanceSheetAjax — asset and liability groups at AsOfDate, and the net profit from PnlFrom to AsOfDate
  async balanceSheet(orgUID: number, rawAsOf: unknown, rawPnlFrom: unknown) {
    const today = await this.today(orgUID);
    const asOfDate = rawAsOf ? AccountingReportsService.date(rawAsOf, "Invalid date format.") : today;
    const pnlFrom = rawPnlFrom ? AccountingReportsService.date(rawPnlFrom, "Invalid date format.") : `${today.slice(0, 4)}-01-01`;
    if (pnlFrom > asOfDate) throw new CiValidationError("P&L From date cannot be after the Balance Sheet date.");

    const group = (label: string) => ({ label, items: [] as Row[], total: 0 });
    const assetGroups: Record<string, ReturnType<typeof group>> = {
      Bank: group("Bank Accounts"), Cash: group("Cash Accounts"), Customer: group("Trade Receivables"), Asset: group("Fixed & Other Assets"),
    };
    const liabGroups: Record<string, ReturnType<typeof group>> = {
      Vendor: group("Trade Payables"), Liability: group("Liabilities & Capital"), Employee: group("Employee Payables"),
    };
    let totalAssets = 0, totalLiabilities = 0;
    const [bsRows, pnlRows] = await Promise.all([this.repo.balanceSheetRows(orgUID, asOfDate), this.repo.pnlRows(orgUID, pnlFrom, asOfDate)]);
    for (const r of bsRows) {
      const [cb, cbType] = calcBalance(num(r.OpeningBalance), sideOf(r.OpeningBalanceType), num(r.PeriodDebit), num(r.PeriodCredit));
      r.ClosingBalance = round(cb, 4);
      r.ClosingBalanceType = cbType;
      const type = String(r.LedgerType);
      if (assetGroups[type]) {
        const contrib = cbType === "Debit" ? cb : -cb;
        assetGroups[type].items.push(r);
        assetGroups[type].total += contrib;
        totalAssets += contrib;
      } else if (liabGroups[type]) {
        const contrib = cbType === "Credit" ? cb : -cb;
        liabGroups[type].items.push(r);
        liabGroups[type].total += contrib;
        totalLiabilities += contrib;
      }
    }
    const pnl = AccountingReportsService.pnlTotals(pnlRows);
    const netProfit = pnl.income - pnl.expense;
    return {
      AssetGroups: assetGroups, LiabGroups: liabGroups, TotalAssets: totalAssets, TotalLiabilities: totalLiabilities, NetProfit: netProfit,
      IsBalanced: Math.abs(totalAssets - totalLiabilities - netProfit) < 0.01, AsOfDate: asOfDate, PnlFrom: pnlFrom,
    };
  }

  // getRatiosAjax — liquidity, profitability, activity and leverage ratios
  async ratios(orgUID: number, q: Record<string, unknown>) {
    const msg = "Invalid date provided.";
    const asOfDate = AccountingReportsService.date(q.AsOfDate, msg);
    const pnlFrom = AccountingReportsService.date(q.PnlFrom, msg);
    const pnlTo = AccountingReportsService.date(q.PnlTo, msg);
    const [bsRows, plRows] = await Promise.all([this.repo.balanceSheetRows(orgUID, asOfDate), this.repo.pnlRows(orgUID, pnlFrom, pnlTo)]);

    let totalAssets = 0, totalLiab = 0, receivables = 0, payables = 0, bankCash = 0;
    for (const r of bsRows) {
      const [cb, cbType] = calcBalance(num(r.OpeningBalance), sideOf(r.OpeningBalanceType), num(r.PeriodDebit), num(r.PeriodCredit));
      const type = String(r.LedgerType);
      if (["Asset", "Bank", "Cash", "Customer"].includes(type)) {
        const v = cbType === "Debit" ? cb : -cb;
        totalAssets += v;
        if (type === "Customer") receivables += Math.max(0, v);
        if (type === "Bank" || type === "Cash") bankCash += Math.max(0, v);
      } else {
        const v = cbType === "Credit" ? cb : -cb;
        totalLiab += v;
        if (type === "Vendor") payables += Math.max(0, v);
      }
    }
    const { income, expense } = AccountingReportsService.pnlTotals(plRows, true);
    const netProfit = income - expense;
    const equity = totalAssets - totalLiab;
    const ratio = (a: number, b: number) => (b > 0.005 ? round(a / b, 2) : null);
    const percent = (a: number, b: number) => (b > 0.005 ? round((a / b) * 100, 1) : null);
    const days = (a: number, b: number) => (b > 0.005 && a > 0.005 ? round((a / b) * 365, 0) : null);
    const Ratios = {
      totalAssets, totalLiab, equity, bankCash, totalReceivables: receivables, totalPayables: payables, totalIncome: income, totalExpense: expense, netProfit,
      currentRatio: ratio(totalAssets, totalLiab), quickRatio: ratio(bankCash + receivables, totalLiab), cashRatio: ratio(bankCash, totalLiab),
      netProfitMargin: percent(netProfit, income), roa: percent(netProfit, totalAssets), roe: percent(netProfit, equity),
      receivablesDays: days(receivables, income), payablesDays: days(payables, expense),
      debtToEquity: ratio(totalLiab, equity), equityRatio: percent(equity, totalAssets),
    };
    return { Ratios, AsOfDate: asOfDate, PnlFrom: pnlFrom, PnlTo: pnlTo };
  }

  // ── Cash flow ─────────────────────────────────────────────────────────────

  // getCashFlowAjax — each bank / cash ledger's opening, movement by journal type, and closing balance
  async cashFlow(orgUID: number, rawFrom: unknown, rawTo: unknown) {
    const dateFrom = AccountingReportsService.date(rawFrom, "Invalid from date.");
    const dateTo = AccountingReportsService.date(rawTo, "Invalid to date.");
    if (dateTo < dateFrom) throw new CiValidationError("To date must be on or after from date.");
    const [balances, categories] = await Promise.all([this.repo.cashFlowBalances(orgUID, dateFrom, dateTo), this.repo.cashFlowCategories(orgUID, dateFrom, dateTo)]);

    const byLedger = new Map<number, { in: Record<string, number>; out: Record<string, number> }>();
    for (const c of categories) {
      const uid = Number(c.CashLedgerUID);
      const entry = byLedger.get(uid) ?? { in: {}, out: {} };
      (c.TransactionType === "Debit" ? entry.in : entry.out)[String(c.ReferenceType ?? "")] = num(c.Total);
      byLedger.set(uid, entry);
    }
    let grandOpening = 0, grandDr = 0, grandCr = 0;
    const accounts = balances.map((r) => {
      const ob = num(r.OpeningBalance);
      const opening = (r.OpeningBalanceType === "Debit" ? ob : 0) + num(r.PreDr) - (r.OpeningBalanceType === "Credit" ? ob : 0) - num(r.PreCr);
      const dr = num(r.PeriodDr);
      const cr = num(r.PeriodCr);
      grandOpening += opening;
      grandDr += dr;
      grandCr += cr;
      const flows = byLedger.get(Number(r.LedgerUID));
      return {
        LedgerUID: Number(r.LedgerUID), LedgerName: r.LedgerName, LedgerType: r.LedgerType, OpeningBal: opening, PeriodDr: dr, PeriodCr: cr,
        ClosingBal: opening + dr - cr, NetChange: dr - cr, Inflows: flows?.in ?? {}, Outflows: flows?.out ?? {},
      };
    });
    return {
      Accounts: accounts, GrandOpeningBal: grandOpening, GrandPeriodDr: grandDr, GrandPeriodCr: grandCr,
      GrandClosingBal: grandOpening + grandDr - grandCr, NetChange: grandDr - grandCr, DateFrom: dateFrom, DateTo: dateTo,
    };
  }

  // ── Budget vs actual ──────────────────────────────────────────────────────

  // getBudgetVActualAjax — the year's annual budget against the range's actuals
  async budgetVsActual(orgUID: number, rawFY: unknown, rawFrom: unknown, rawTo: unknown) {
    const fy = Number(rawFY) || Number((await this.today(orgUID)).slice(0, 4));
    const dateFrom = AccountingReportsService.date(rawFrom, "Invalid from date.");
    const dateTo = AccountingReportsService.date(rawTo, "Invalid to date.");
    const income: Row[] = [];
    const expense: Row[] = [];
    const totals = { budgetIncome: 0, actualIncome: 0, budgetExpense: 0, actualExpense: 0, budgetNet: 0, actualNet: 0, netVariance: 0 };
    for (const r of await this.repo.budgetRows(orgUID, fy, dateFrom, dateTo)) {
      const budgeted = num(r.BudgetedAmount);
      const base = { LedgerUID: r.LedgerUID, LedgerCode: r.LedgerCode, LedgerName: r.LedgerName, Budgeted: budgeted };
      if (r.LedgerType === "Income") {
        const actual = num(r.PeriodCr) - num(r.PeriodDr);
        income.push({ ...base, Actual: actual, Variance: actual - budgeted, Pct: budgeted > 0.005 ? round((actual / budgeted) * 100, 1) : null });
        totals.budgetIncome += budgeted;
        totals.actualIncome += actual;
      } else {
        const actual = num(r.PeriodDr) - num(r.PeriodCr);
        expense.push({ ...base, Actual: actual, Variance: budgeted - actual, Pct: budgeted > 0.005 ? round((actual / budgeted) * 100, 1) : null });
        totals.budgetExpense += budgeted;
        totals.actualExpense += actual;
      }
    }
    totals.budgetNet = totals.budgetIncome - totals.budgetExpense;
    totals.actualNet = totals.actualIncome - totals.actualExpense;
    totals.netVariance = totals.actualNet - totals.budgetNet;
    return { Income: income, Expense: expense, Totals: totals, FY: fy, DateFrom: dateFrom, DateTo: dateTo };
  }

  // ── Aged receivables / payables ───────────────────────────────────────────

  /**
   * getAgedReceivablesAjax / getAgedPayablesAjax — outstanding per customer (Debit balance) or vendor (Credit balance),
   * aged first-in-first-out: payments and the opening counter-balance settle the oldest band first.
   */
  async aged(orgUID: number, ledgerType: "Customer" | "Vendor", rawAsOf: unknown) {
    const asOfDate = AccountingReportsService.date(rawAsOf, "Invalid as-of date.");
    const rows = await this.repo.agedRows(orgUID, ledgerType, asOfDate, { d30: addDays(asOfDate, -30), d60: addDays(asOfDate, -60), d90: addDays(asOfDate, -90) });
    const receivable = ledgerType === "Customer";
    const p = receivable ? "Dr" : "Cr";
    const totals = { outstanding: 0, "0to30": 0, "31to60": 0, "61to90": 0, "90plus": 0 };
    const result: Row[] = [];
    for (const r of rows) {
      const ob = num(r.OpeningBalance);
      const obDr = r.OpeningBalanceType === "Debit" ? ob : 0;
      const obCr = r.OpeningBalanceType === "Credit" ? ob : 0;
      const outstanding = receivable ? obDr + num(r.TotalDr) - obCr - num(r.TotalCr) : obCr + num(r.TotalCr) - obDr - num(r.TotalDr);
      if (outstanding < 0.005) continue;

      const bands: Bands = {
        "90plus": num(r[`${p}Band90plus`]) + (receivable ? obDr : obCr),
        "61to90": num(r[`${p}Band61_90`]),
        "31to60": num(r[`${p}Band31_60`]),
        "0to30": num(r[`${p}Band0_30`]),
      };
      let payments = receivable ? obCr + num(r.TotalCr) : obDr + num(r.TotalDr);
      const aged = { ...bands };
      for (const band of ["90plus", "61to90", "31to60", "0to30"] as const) {
        const paid = Math.min(payments, bands[band]);
        payments -= paid;
        aged[band] = Math.max(0, bands[band] - paid);
      }
      result.push({
        LedgerUID: r.LedgerUID, LedgerName: r.LedgerName, LedgerCode: r.LedgerCode, NetOutstanding: outstanding,
        Band0to30: aged["0to30"], Band31to60: aged["31to60"], Band61to90: aged["61to90"], Band90plus: aged["90plus"],
      });
      totals.outstanding += outstanding;
      for (const band of ["0to30", "31to60", "61to90", "90plus"] as const) totals[band] += aged[band];
    }
    return { Rows: result, Totals: totals, AsOfDate: asOfDate };
  }

  // ── Day book ──────────────────────────────────────────────────────────────

  // daybook — the bank / cash ledgers for the filter
  async dayBookPageData(orgUID: number) {
    return { CashBankLedgers: await this.repo.activeLedgers(orgUID, "", 0, ["Bank", "Cash"]) };
  }

  // getDayBookAjax — entries grouped by day, then journal
  async dayBook(orgUID: number, q: Record<string, unknown>) {
    const dateFrom = AccountingReportsService.date(q.DateFrom, "Invalid from date.");
    const dateTo = AccountingReportsService.date(q.DateTo, "Invalid to date.");
    if (dateTo < dateFrom) throw new CiValidationError("To date must be on or after from date.");
    const rows = await this.repo.dayBookRows(orgUID, dateFrom, dateTo, Number(q.CashBankOnly) === 1, Number(q.LedgerUID) || 0);

    const days = new Map<string, { date: string; journals: Map<number, Row & { entries: Row[] }>; dailyDr: number; dailyCr: number }>();
    for (const row of rows) {
      const date = String(row.JournalDate);
      const day = days.get(date) ?? { date, journals: new Map(), dailyDr: 0, dailyCr: 0 };
      days.set(date, day);
      const jid = Number(row.JournalUID);
      if (!day.journals.has(jid)) day.journals.set(jid, { JournalNo: row.JournalNo, ReferenceType: row.ReferenceType, ReferenceNo: row.ReferenceNo, Narration: row.Narration, entries: [] });
      day.journals.get(jid)!.entries.push(row);
      if (row.TransactionType === "Debit") day.dailyDr += num(row.Amount);
      else day.dailyCr += num(row.Amount);
    }
    const Days = [...days.values()].map((d) => ({ date: d.date, journals: [...d.journals.entries()].map(([JournalUID, j]) => ({ JournalUID, ...j })), dailyDr: d.dailyDr, dailyCr: d.dailyCr }));
    const GrandDr = Days.reduce((s, d) => s + d.dailyDr, 0);
    const GrandCr = Days.reduce((s, d) => s + d.dailyCr, 0);
    return { Days, GrandDr, GrandCr, DayCount: Days.length, DateFrom: dateFrom, DateTo: dateTo };
  }
}
