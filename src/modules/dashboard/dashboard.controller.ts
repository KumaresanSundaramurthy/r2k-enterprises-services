import { Controller, Get, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Min } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { CHART_TYPES, ChartType, DashboardService } from "./dashboard.service";

export class DashboardQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number, example: 1, description: "BranchUID the user is currently working in" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId!: number;
}

export class DashboardChartDto extends DashboardQueryDto {
  @ApiPropertyOptional({ enum: CHART_TYPES, default: "sales", description: "sales / receivable / payable: last 30 days per day; monthly: last 12 months per month" })
  @IsOptional()
  @IsIn(CHART_TYPES)
  type: ChartType = "sales";
}

/**
 * Dashboard of CI3 (Dashboard::index), one endpoint per widget: the page calls them all at once and fills each
 * widget as its response arrives. "Today" and "this month" are in the organisation's timezone.
 */
@ApiTags("Dashboard")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("getKpis")
  @ApiOperation({
    summary: "KPI tabs: TodaySales / TodayPurchases {total, count}, MonthlyComparison / MonthlyPurchasesComparison {this_month, last_month}, TotalReceivable, TotalPayable",
  })
  async getKpis(@Query() dto: DashboardQueryDto) {
    return ciSuccess(await this.dashboard.getKpis(dto.orgId, dto.branchId));
  }

  @Get("getChart")
  @ApiOperation({ summary: "Chart of the selected KPI tab (Type, ChartData [{sale_date, total}])" })
  async getChart(@Query() dto: DashboardChartDto) {
    return ciSuccess(await this.dashboard.getChart(dto.orgId, dto.branchId, dto.type));
  }

  @Get("getPendingCounts")
  @ApiOperation({ summary: "Pending actions strip (PendingCounts {draft_count, open_invoices, open_pos, open_purchases})" })
  async getPendingCounts(@Query() dto: DashboardQueryDto) {
    return ciSuccess(await this.dashboard.getPendingCounts(dto.orgId, dto.branchId));
  }

  @Get("getOverdueInvoices")
  @ApiOperation({ summary: "Open invoices past their due date, oldest due first, 6 at most (OverdueInvoices)" })
  async getOverdueInvoices(@Query() dto: DashboardQueryDto) {
    return ciSuccess(await this.dashboard.getOverdueInvoices(dto.orgId, dto.branchId));
  }

  @Get("getTopParties")
  @ApiOperation({ summary: "5 largest receivable and payable balances of the org (TopCustomers, TopVendors)" })
  async getTopParties(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.dashboard.getTopParties(dto.orgId));
  }

  @Get("getRecentTransactions")
  @ApiOperation({ summary: "Latest 10 documents of any module (RecentTransactions)" })
  async getRecentTransactions(@Query() dto: DashboardQueryDto) {
    return ciSuccess(await this.dashboard.getRecentTransactions(dto.orgId, dto.branchId));
  }

  @Get("getExpenseSummary")
  @ApiOperation({ summary: "This month's expenses of the org, top 5 categories (ExpenseSummary [{category, total}])" })
  async getExpenseSummary(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.dashboard.getExpenseSummary(dto.orgId));
  }

  @Get("getTopProducts")
  @ApiOperation({ summary: "This month's 5 best-selling products by invoiced revenue (TopProducts [{ProductName, qty_sold, revenue}])" })
  async getTopProducts(@Query() dto: DashboardQueryDto) {
    return ciSuccess(await this.dashboard.getTopProducts(dto.orgId, dto.branchId));
  }
}
