import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { filterOf } from "../hrms/hrms-common";
import { AcceptForm } from "../products/product-files";
import { AccountingReportsService } from "./accounting-reports.service";
import { AccountingService } from "./accounting.service";

const PAGE = { name: "pageNo", required: false, description: "Page number (default 1)" };

// ── DTOs (values are checked by the services so the messages match CI3) ─────────

export class AccountingListDto extends OrgContextDto {
  @ApiPropertyOptional({ description: "Filter as JSON" }) @Allow() Filter?: string;
  @ApiPropertyOptional({ description: "Rows per page; default the organisation's RowLimit" }) @Allow() RowLimit?: string | number;
}

export class FyQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number, description: "Default this year" }) @Allow() FinancialYear?: string | number;
}

export class LedgerRangeQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() LedgerUID?: string | number;
  @ApiPropertyOptional({ example: "2026-04-01" }) @Allow() DateFrom?: string;
  @ApiPropertyOptional({ example: "2026-11-30" }) @Allow() DateTo?: string;
}

export class DateRangeQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "2026-04-01" }) @Allow() DateFrom?: string;
  @ApiPropertyOptional({ example: "2026-11-30" }) @Allow() DateTo?: string;
}

export class BalanceSheetQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "2026-11-30", description: "Default today" }) @Allow() AsOfDate?: string;
  @ApiPropertyOptional({ example: "2026-01-01", description: "Start of the net-profit period; default 1 Jan" }) @Allow() PnlFrom?: string;
}

export class RatiosQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "2026-11-30" }) @Allow() AsOfDate?: string;
  @ApiPropertyOptional({ example: "2026-04-01" }) @Allow() PnlFrom?: string;
  @ApiPropertyOptional({ example: "2026-11-30" }) @Allow() PnlTo?: string;
}

export class ComparativeQueryDto extends OrgContextDto {
  @ApiPropertyOptional() @Allow() P1From?: string;
  @ApiPropertyOptional() @Allow() P1To?: string;
  @ApiPropertyOptional() @Allow() P2From?: string;
  @ApiPropertyOptional() @Allow() P2To?: string;
  @ApiPropertyOptional({ default: "Period 1" }) @Allow() P1Label?: string;
  @ApiPropertyOptional({ default: "Period 2" }) @Allow() P2Label?: string;
}

export class BudgetQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({ type: Number, description: "Budget year; default this year" }) @Allow() FY?: string | number;
}

export class AsOfQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "2026-11-30" }) @Allow() AsOfDate?: string;
}

export class DayBookQueryDto extends DateRangeQueryDto {
  @ApiPropertyOptional({ description: "1 = bank / cash ledgers only" }) @Allow() CashBankOnly?: string | number;
  @ApiPropertyOptional({ type: Number, description: "One ledger (overrides CashBankOnly)" }) @Allow() LedgerUID?: string | number;
}

export class LedgerSearchQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ description: "Search text (code or name)" }) @Allow() q?: string;
}

export class IdQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() JournalUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() RecurUID?: string | number;
}

class ListEchoDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "The list's Filter (JSON) for the returned first page" }) @Allow() Filter?: string;
  @ApiPropertyOptional() @Allow() RowLimit?: string | number;
}

export class LedgerFormDto extends ListEchoDto {
  @ApiPropertyOptional({ type: Number, description: "0 / empty = new ledger" }) @Allow() LedgerUID?: string | number;
  @ApiPropertyOptional({ description: "Required for a new ledger; cannot be changed later" }) @Allow() LedgerCode?: string;
  @ApiPropertyOptional() @Allow() LedgerName?: string;
  @ApiPropertyOptional({ enum: ["Asset", "Liability", "Income", "Expense", "Customer", "Vendor", "Employee", "Bank", "Cash"] }) @Allow() LedgerType?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() ParentLedgerUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() OpeningBalance?: string | number;
  @ApiPropertyOptional({ enum: ["Debit", "Credit"] }) @Allow() OpeningBalanceType?: string;
}

export class LedgerStatusDto extends ListEchoDto {
  @ApiPropertyOptional({ type: Number }) @Allow() LedgerUID?: string | number;
  @ApiPropertyOptional({ description: "1 = active, 0 = inactive" }) @Allow() IsActive?: string | number;
}

export class LedgerIdDto extends ListEchoDto {
  @ApiPropertyOptional({ type: Number }) @Allow() LedgerUID?: string | number;
}

export class ManualJournalDto extends OrgUserContextDto {
  @ApiPropertyOptional({ example: "2026-11-11" }) @Allow() JournalDate?: string;
  @ApiPropertyOptional() @Allow() Narration?: string;
  @ApiPropertyOptional({ description: "Lines[] of { LedgerUID, Type: Debit|Credit, Amount, Particulars } (array, Lines[0][..] or JSON); at least 2, balanced" })
  @Allow()
  Lines?: unknown;
}

export class JournalIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() JournalUID?: string | number;
}

export class BankReconSaveDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: [Number], description: "EntryUIDs to mark cleared" }) @Allow() ClearedUIDs?: unknown;
  @ApiPropertyOptional({ type: [Number], description: "EntryUIDs to mark uncleared" }) @Allow() UnclearedUIDs?: unknown;
}

export class RecurringFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "0 / empty = new" }) @Allow() RecurUID?: string | number;
  @ApiPropertyOptional() @Allow() Title?: string;
  @ApiPropertyOptional() @Allow() Narration?: string;
  @ApiPropertyOptional({ enum: ["Daily", "Weekly", "Monthly", "Quarterly", "Yearly"] }) @Allow() Frequency?: string;
  @ApiPropertyOptional({ example: "2026-12-01" }) @Allow() StartDate?: string;
  @ApiPropertyOptional() @Allow() EndDate?: string;
  @ApiPropertyOptional({ description: "Lines (JSON or array) of { LedgerUID, Type, Amount, Particulars }; at least 2, balanced" }) @Allow() Lines?: unknown;
}

export class RecurIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() RecurUID?: string | number;
}

export class PeriodLockDto extends OrgUserContextDto {
  @ApiPropertyOptional({ example: "2026-03-31" }) @Allow() LockDate?: string;
}

export class BudgetAmountDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() LedgerUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() FY?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() Amount?: string | number;
}

const pageOf = (pageNo?: string) => Math.max(1, Number(pageNo) || 1);
const limitOf = (dto: { RowLimit?: string | number }) => Number(dto.RowLimit) || undefined;

// CI3 Accounting controller: same method names; reads are GET, changes are POST.
@ApiTags("Accounting")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/accounting")
export class AccountingController {
  constructor(
    private readonly accounting: AccountingService,
    private readonly reports: AccountingReportsService
  ) {}

  // ── Chart of Accounts ───────────────────────────────────────────────────────

  @Get("getChartOfAccountsPageData")
  @ApiOperation({ summary: "Page data (chartofaccounts): Stats, first page (Data, TotalCount, PageNo, RowLimit), ParentLedgers" })
  async getChartOfAccountsPageData(@Query() dto: AccountingListDto) {
    return ciSuccess(await this.accounting.chartPageData(dto.orgId, limitOf(dto)));
  }

  @Get(["getChartOfAccountsPage", "getChartOfAccountsPage/:pageNo"])
  @ApiParam(PAGE)
  @ApiOperation({ summary: "One page; Filter JSON { LedgerType, SearchAllData } (Data, TotalCount, PageNo, RowLimit, Stats)" })
  async getChartOfAccountsPage(@Param("pageNo") pageNo: string | undefined, @Query() dto: AccountingListDto) {
    return ciSuccess(await this.accounting.chartPage(dto.orgId, pageOf(pageNo), limitOf(dto), filterOf(dto.Filter)));
  }

  @Post("saveLedger")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create (LedgerUID 0) or update a ledger; returns Message and the refreshed first page" })
  async saveLedger(@Body() dto: LedgerFormDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.saveLedger(writeContext(dto, req), { ...dto }));
  }

  @Post("toggleLedgerStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Activate / deactivate a ledger; returns Message and the refreshed first page" })
  async toggleLedgerStatus(@Body() dto: LedgerStatusDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.toggleLedger(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteLedger")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Delete a ledger without journal entries; returns Message and the refreshed first page" })
  async deleteLedger(@Body() dto: LedgerIdDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.deleteLedger(writeContext(dto, req), { ...dto }));
  }

  @Get("getLedgersForJournal")
  @ApiOperation({ summary: "Ledger search for the journal forms: {results: [{id, text, code, type}]} (max 50)" })
  async getLedgersForJournal(@Query() dto: LedgerSearchQueryDto) {
    return ciSuccess(await this.accounting.ledgersForJournal(dto.orgId, String(dto.q ?? "")));
  }

  // ── Trial balance / general ledger ──────────────────────────────────────────

  @Get("getTrialBalancePageData")
  @ApiOperation({ summary: "Page data (trialbalance): FinancialYears, DefaultFY" })
  async getTrialBalancePageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.reports.trialBalancePageData(dto.orgId));
  }

  @Get("getTrialBalanceAjax")
  @ApiOperation({ summary: "Trial balance of a year: Rows (with ClosingBalance), GrandDebit, GrandCredit, TotalObDr, TotalObCr, IsBalanced, RowCount" })
  async getTrialBalanceAjax(@Query() dto: FyQueryDto) {
    return ciSuccess(await this.reports.trialBalance(dto.orgId, dto.FinancialYear));
  }

  @Get("getGeneralLedgerPageData")
  @ApiOperation({ summary: "Page data (generalledger): AllLedgers" })
  async getGeneralLedgerPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.reports.generalLedgerPageData(dto.orgId));
  }

  @Get("getLedgerStatementAjax")
  @ApiOperation({ summary: "Ledger statement: Lines (with RunningBalance), Opening/Closing balance and type, TotalDebit, TotalCredit" })
  async getLedgerStatementAjax(@Query() dto: LedgerRangeQueryDto) {
    return ciSuccess(await this.reports.ledgerStatement(dto.orgId, Number(dto.LedgerUID) || 0, dto.DateFrom, dto.DateTo));
  }

  // ── Journals ────────────────────────────────────────────────────────────────

  @Get("getJournalListPageData")
  @ApiOperation({ summary: "Page data (journallist): Stats and the first page" })
  async getJournalListPageData(@Query() dto: AccountingListDto) {
    return ciSuccess(await this.accounting.journalPageData(dto.orgId, limitOf(dto)));
  }

  @Get(["getJournalListPage", "getJournalListPage/:pageNo"])
  @ApiParam(PAGE)
  @ApiOperation({ summary: "One page; Filter JSON { ReferenceType, DateFrom, DateTo, SearchAllData } (Data, TotalCount, PageNo, RowLimit, Stats)" })
  async getJournalListPage(@Param("pageNo") pageNo: string | undefined, @Query() dto: AccountingListDto) {
    return ciSuccess(await this.accounting.journalPage(dto.orgId, pageOf(pageNo), limitOf(dto), filterOf(dto.Filter)));
  }

  @Get("getJournalDetail")
  @ApiOperation({ summary: "A journal and its lines (Journal with Lines, JournalNo)" })
  async getJournalDetail(@Query() dto: IdQueryDto) {
    return ciSuccess(await this.accounting.journalDetail(dto.orgId, Number(dto.JournalUID) || 0));
  }

  @Post("saveManualJournal")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Post a manual journal (Message, JournalNo, JournalUID)" })
  async saveManualJournal(@Body() dto: ManualJournalDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.saveManualJournal(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteManualJournal")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Delete a manual journal: soft-deleted and reversed today" })
  async deleteManualJournal(@Body() dto: JournalIdDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.deleteManualJournal(writeContext(dto, req), postInt(dto, "JournalUID")));
  }

  // ── Bank reconciliation ─────────────────────────────────────────────────────

  @Get("getBankReconPageData")
  @ApiOperation({ summary: "Page data (bankreconciliation): BankLedgers" })
  async getBankReconPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.accounting.bankReconPageData(dto.orgId));
  }

  @Get("getBankReconAjax")
  @ApiOperation({ summary: "Bank / cash ledger entries with book and cleared balances (ReconciliationEnabled = IsReconciled column exists)" })
  async getBankReconAjax(@Query() dto: LedgerRangeQueryDto) {
    return ciSuccess(await this.accounting.bankRecon(dto.orgId, Number(dto.LedgerUID) || 0, dto.DateFrom, dto.DateTo));
  }

  @Post("saveBankRecon")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Mark entries cleared / uncleared (needs Accounting.JournalEntries.IsReconciled)" })
  async saveBankRecon(@Body() dto: BankReconSaveDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.saveBankRecon(writeContext(dto, req), { ...dto }));
  }

  // ── Statements ──────────────────────────────────────────────────────────────

  @Get("getPandLAjax")
  @ApiOperation({ summary: "Profit & loss: Income, Expense (with NetAmount), TotalIncome, TotalExpense, NetProfit" })
  async getPandLAjax(@Query() dto: DateRangeQueryDto) {
    return ciSuccess(await this.reports.profitLoss(dto.orgId, dto.DateFrom, dto.DateTo));
  }

  @Get("getBalanceSheetAjax")
  @ApiOperation({ summary: "Balance sheet: AssetGroups, LiabGroups, TotalAssets, TotalLiabilities, NetProfit, IsBalanced" })
  async getBalanceSheetAjax(@Query() dto: BalanceSheetQueryDto) {
    return ciSuccess(await this.reports.balanceSheet(dto.orgId, dto.AsOfDate, dto.PnlFrom));
  }

  @Get("getComparativePnLAjax")
  @ApiOperation({ summary: "Two-period P&L: Income, Expense (Net1, Net2, Variance, PctChange), Totals" })
  async getComparativePnLAjax(@Query() dto: ComparativeQueryDto) {
    return ciSuccess(await this.reports.comparativePnL(dto.orgId, { ...dto }));
  }

  @Get("getRatiosAjax")
  @ApiOperation({ summary: "Financial ratios (Ratios)" })
  async getRatiosAjax(@Query() dto: RatiosQueryDto) {
    return ciSuccess(await this.reports.ratios(dto.orgId, { ...dto }));
  }

  @Get("getCashFlowAjax")
  @ApiOperation({ summary: "Cash flow: Accounts (opening, inflows / outflows by type, closing) and grand totals" })
  async getCashFlowAjax(@Query() dto: DateRangeQueryDto) {
    return ciSuccess(await this.reports.cashFlow(dto.orgId, dto.DateFrom, dto.DateTo));
  }

  @Get("getBudgetVActualAjax")
  @ApiOperation({ summary: "Budget vs actual: Income, Expense, Totals" })
  async getBudgetVActualAjax(@Query() dto: BudgetQueryDto) {
    return ciSuccess(await this.reports.budgetVsActual(dto.orgId, dto.FY, dto.DateFrom, dto.DateTo));
  }

  @Post("saveBudgetAmount")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Save a ledger's annual budget (Amount)" })
  async saveBudgetAmount(@Body() dto: BudgetAmountDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.saveBudget(writeContext(dto, req), { ...dto }));
  }

  @Get("getAgedReceivablesAjax")
  @ApiOperation({ summary: "Aged receivables: Rows (NetOutstanding, Band0to30 … Band90plus), Totals" })
  async getAgedReceivablesAjax(@Query() dto: AsOfQueryDto) {
    return ciSuccess(await this.reports.aged(dto.orgId, "Customer", dto.AsOfDate));
  }

  @Get("getAgedPayablesAjax")
  @ApiOperation({ summary: "Aged payables: Rows (NetOutstanding, Band0to30 … Band90plus), Totals" })
  async getAgedPayablesAjax(@Query() dto: AsOfQueryDto) {
    return ciSuccess(await this.reports.aged(dto.orgId, "Vendor", dto.AsOfDate));
  }

  @Get("getDayBookPageData")
  @ApiOperation({ summary: "Page data (daybook): CashBankLedgers" })
  async getDayBookPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.reports.dayBookPageData(dto.orgId));
  }

  @Get("getDayBookAjax")
  @ApiOperation({ summary: "Day book: Days → journals → entries, GrandDr, GrandCr, DayCount" })
  async getDayBookAjax(@Query() dto: DayBookQueryDto) {
    return ciSuccess(await this.reports.dayBook(dto.orgId, { ...dto }));
  }

  // ── Recurring journals ──────────────────────────────────────────────────────

  @Get("getRecurringJournalsPageData")
  @ApiOperation({ summary: "Page data (recurringjournals): Stats and the first page" })
  async getRecurringJournalsPageData(@Query() dto: AccountingListDto) {
    return ciSuccess(await this.accounting.recurringPageData(dto.orgId, limitOf(dto)));
  }

  @Get(["getRecurringJournalsPage", "getRecurringJournalsPage/:pageNo"])
  @ApiParam(PAGE)
  @ApiOperation({ summary: "One page; Filter JSON { IsActive, Due, SearchAllData } (Data, TotalCount, PageNo, RowLimit, Stats)" })
  async getRecurringJournalsPage(@Param("pageNo") pageNo: string | undefined, @Query() dto: AccountingListDto) {
    return ciSuccess(await this.accounting.recurringPage(dto.orgId, pageOf(pageNo), limitOf(dto), filterOf(dto.Filter)));
  }

  @Get("getRecurringJournalAjax")
  @ApiOperation({ summary: "One recurring journal for the edit form (RecurUID, Title, Narration, Frequency, StartDate, EndDate, Lines)" })
  async getRecurringJournalAjax(@Query() dto: IdQueryDto) {
    return ciSuccess(await this.accounting.recurringDetail(dto.orgId, Number(dto.RecurUID) || 0));
  }

  @Post("saveRecurringJournal")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create (RecurUID 0) or update a recurring journal (Message, RecurUID)" })
  async saveRecurringJournal(@Body() dto: RecurringFormDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.saveRecurring(writeContext(dto, req), { ...dto }));
  }

  @Post("postRecurringJournal")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Post one recurring journal today (JournalUID, NextRunDate, Ended)" })
  async postRecurringJournal(@Body() dto: RecurIdDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.postRecurring(writeContext(dto, req), postInt(dto, "RecurUID")));
  }

  @Post("postAllDueJournals")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Post every due recurring journal (Posted, Errors)" })
  async postAllDueJournals(@Body() dto: OrgUserContextDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.postAllDue(writeContext(dto, req)));
  }

  @Post("toggleRecurringStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Pause / resume a recurring journal (IsActive)" })
  async toggleRecurringStatus(@Body() dto: RecurIdDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.toggleRecurring(writeContext(dto, req), postInt(dto, "RecurUID")));
  }

  @Post("deleteRecurringJournal")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Delete a recurring journal" })
  async deleteRecurringJournal(@Body() dto: RecurIdDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.deleteRecurring(writeContext(dto, req), postInt(dto, "RecurUID")));
  }

  // ── Period lock ─────────────────────────────────────────────────────────────

  @Get("getPeriodLock")
  @ApiOperation({ summary: "Page data (periodlock): CurrentLock or null" })
  async getPeriodLock(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.accounting.periodLock(dto.orgId));
  }

  @Post("savePeriodLock")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Lock the books up to LockDate (Message, LockedUpTo)" })
  async savePeriodLock(@Body() dto: PeriodLockDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.savePeriodLock(writeContext(dto, req), dto.LockDate));
  }

  @Post("removePeriodLock")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Remove the period lock" })
  async removePeriodLock(@Body() dto: OrgUserContextDto, @Req() req: Request) {
    return ciSuccess(await this.accounting.removePeriodLock(writeContext(dto, req)));
  }
}
