import { Controller, Get, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { BankStatementDto, CustomerLedgerDto, GstMonthDto, ReportAsOfDto, ReportDateDto, ReportGroupedRangeDto, ReportRangeDto, ReportYearDto, SupplierLedgerDto } from "./reports.dto";
import { ReportsService } from "./reports.service";

const ITEMWISE_COLUMNS = "DocNo, TransDate, PartyName, ItemName, Quantity, UnitName, UnitPrice, TaxableAmount, TaxPercentage, TaxAmount, DiscountAmount, NetAmount (max 3000)";
const TDS_EXPENSE_COLUMNS = "expenses with TDS (DocNo, TransDate, VendorName, VendorGSTIN, TdsSection, TdsSectionDesc, BaseAmount, TdsPct, TdsAmount, NetAmount, DocStatus, IsPaid); default this month";
const REGISTER_COLUMNS = "DocNo, TransDate, PartyName, Taxable, CgstAmount, SgstAmount, IgstAmount, TaxAmount, RoundOff, NetAmount, DocStatus (max 2000)";

/**
 * Reports of CI3 (Reports controller), same action names. Each answers { Status: "Success", rows } like CI3;
 * failures are { Error: true, Message }.
 */
@ApiTags("Reports")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("getSalesSummaryData")
  @ApiOperation({ summary: "Sales summary: Invoice (103) / Sales Return (106) per period (Period, ModuleUID, TxCount, SubTotalAmt, TaxAmt, NetAmt, FirstDate)" })
  async getSalesSummaryData(@Query() dto: ReportGroupedRangeDto) {
    return ciSuccess(await this.reports.salesSummary(dto.orgId, dto.from, dto.to, dto.groupby));
  }

  @Get("getPurchaseSummaryData")
  @ApiOperation({ summary: "Purchase summary: Purchase (105) / Purchase Return (108) per period (same columns as the sales summary)" })
  async getPurchaseSummaryData(@Query() dto: ReportGroupedRangeDto) {
    return ciSuccess(await this.reports.purchaseSummary(dto.orgId, dto.from, dto.to, dto.groupby));
  }

  @Get("getMonthlySummaryData")
  @ApiOperation({ summary: "Monthly summary of a calendar year: 103 / 105 / 106 / 108 per month (Period, Mo, ModuleUID, TxCount, NetAmt)" })
  async getMonthlySummaryData(@Query() dto: ReportYearDto) {
    return ciSuccess(await this.reports.monthlySummary(dto.orgId, dto.year));
  }

  @Get("getPaymentReceivedData")
  @ApiOperation({ summary: "Payments received from customers in the range, newest first (max 1000)" })
  async getPaymentReceivedData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.paymentReceived(dto.orgId, dto.from, dto.to));
  }

  @Get("getPaymentMadeData")
  @ApiOperation({ summary: "Payments made to vendors in the range, newest first (max 1000)" })
  async getPaymentMadeData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.paymentMade(dto.orgId, dto.from, dto.to));
  }

  // ── Item-wise (document lines) ────────────────────────────────────────────

  @Get("getInvoiceItemwiseData")
  @ApiOperation({ summary: `Invoice item-wise: ${ITEMWISE_COLUMNS}` })
  async getInvoiceItemwiseData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.itemwise(dto.orgId, "invoice", dto.from, dto.to));
  }

  @Get("getPurchaseItemwiseData")
  @ApiOperation({ summary: `Purchase item-wise: ${ITEMWISE_COLUMNS}` })
  async getPurchaseItemwiseData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.itemwise(dto.orgId, "purchase", dto.from, dto.to));
  }

  @Get("getSalesReturnItemwiseData")
  @ApiOperation({ summary: `Sales return item-wise: ${ITEMWISE_COLUMNS}` })
  async getSalesReturnItemwiseData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.itemwise(dto.orgId, "salesReturn", dto.from, dto.to));
  }

  @Get("getPurchaseReturnItemwiseData")
  @ApiOperation({ summary: `Purchase return item-wise: ${ITEMWISE_COLUMNS}` })
  async getPurchaseReturnItemwiseData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.itemwise(dto.orgId, "purchaseReturn", dto.from, dto.to));
  }

  // ── Registers (one row per document) ──────────────────────────────────────

  @Get("getSalesRegisterData")
  @ApiOperation({ summary: `Sales register (invoices): ${REGISTER_COLUMNS}` })
  async getSalesRegisterData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.register(dto.orgId, "invoice", dto.from, dto.to));
  }

  @Get("getPurchaseRegisterData")
  @ApiOperation({ summary: `Purchase register: ${REGISTER_COLUMNS}` })
  async getPurchaseRegisterData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.register(dto.orgId, "purchase", dto.from, dto.to));
  }

  @Get("getSalesReturnRegisterData")
  @ApiOperation({ summary: `Sales return register: ${REGISTER_COLUMNS}` })
  async getSalesReturnRegisterData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.register(dto.orgId, "salesReturn", dto.from, dto.to));
  }

  @Get("getPurchaseReturnRegisterData")
  @ApiOperation({ summary: `Purchase return register: ${REGISTER_COLUMNS}` })
  async getPurchaseReturnRegisterData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.register(dto.orgId, "purchaseReturn", dto.from, dto.to));
  }

  @Get("getDeliveryChallanRegisterData")
  @ApiOperation({ summary: `Delivery challan register: ${REGISTER_COLUMNS}` })
  async getDeliveryChallanRegisterData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.register(dto.orgId, "deliveryChallan", dto.from, dto.to));
  }

  // ── Tax reports ───────────────────────────────────────────────────────────

  @Get("getGstr1Data")
  @ApiOperation({ summary: "GSTR-1 for a month: b2b (GSTIN customers), b2cs (others) and cdnr (sales returns to GSTIN customers)" })
  async getGstr1Data(@Query() dto: GstMonthDto) {
    return ciSuccess(await this.reports.gstr1(dto.orgId, dto.month, dto.year));
  }

  @Get("getGstr2bData")
  @ApiOperation({ summary: "GSTR-2B for a month: purchase bills from GSTIN vendors (rows)" })
  async getGstr2bData(@Query() dto: GstMonthDto) {
    return ciSuccess(await this.reports.gstr2b(dto.orgId, dto.month, dto.year));
  }

  @Get("getGstr3bData")
  @ApiOperation({ summary: "GSTR-3B for a month: outward (sales / returns) and itc (purchases / purchase returns) totals" })
  async getGstr3bData(@Query() dto: GstMonthDto) {
    return ciSuccess(await this.reports.gstr3b(dto.orgId, dto.month, dto.year));
  }

  @Get("getGstr7Data")
  @ApiOperation({ summary: `GSTR-7: ${TDS_EXPENSE_COLUMNS}` })
  async getGstr7Data(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.taxRange(dto.orgId, "tdsExpenses", dto.from, dto.to));
  }

  @Get("getHsnData")
  @ApiOperation({ summary: "HSN summary of invoices: HsnCode, UOM, TaxRate, TotalQty, TaxableValue, Cgst / Sgst / Igst / TaxAmount, InvCount (default this month)" })
  async getHsnData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.taxRange(dto.orgId, "hsnSummary", dto.from, dto.to));
  }

  @Get("getTdsReceivableData")
  @ApiOperation({ summary: "TDS receivable: invoices of ₹30,000 or more (InvNo, TransDate, CustomerName, CustomerGSTIN, Taxable, TaxAmount, NetAmount, DocStatus)" })
  async getTdsReceivableData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.taxRange(dto.orgId, "tdsReceivable", dto.from, dto.to));
  }

  @Get("getTdsPayableData")
  @ApiOperation({ summary: `TDS payable: ${TDS_EXPENSE_COLUMNS}` })
  async getTdsPayableData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.taxRange(dto.orgId, "tdsExpenses", dto.from, dto.to));
  }

  @Get("getTcsReceivableData")
  @ApiOperation({ summary: "TCS receivable: not tracked yet — always empty rows" })
  getTcsReceivableData(@Query() _dto: ReportRangeDto) {
    return ciSuccess(this.reports.tcs());
  }

  @Get("getTcsPayableData")
  @ApiOperation({ summary: "TCS payable: not tracked yet — always empty rows" })
  getTcsPayableData(@Query() _dto: ReportRangeDto) {
    return ciSuccess(this.reports.tcs());
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  @Get("getDayBookData")
  @ApiOperation({ summary: "Day book: the day's documents and payments ({ Status, entries }); EntryTime in the org's time (H:i:s)" })
  async getDayBookData(@Query() dto: ReportDateDto) {
    return ciSuccess(await this.reports.dayBook(dto.orgId, dto.date));
  }

  @Get("getPLStatementData")
  @ApiOperation({ summary: "P&L: Income / Expense ledgers with PeriodDebit, PeriodCredit (only journals dated in the range; reversals excluded)" })
  async getPLStatementData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.ledgerReport(dto.orgId, "plStatement", dto.from, dto.to));
  }

  @Get("getBalanceSheetData")
  @ApiOperation({ summary: "Balance sheet: ledgers with OpeningBalance(Type), TotalDebit, TotalCredit up to asof" })
  async getBalanceSheetData(@Query() dto: ReportAsOfDto) {
    return ciSuccess(await this.reports.balanceSheet(dto.orgId, dto.asof));
  }

  @Get("getTrialBalanceData")
  @ApiOperation({ summary: "Trial balance: ledgers with activity or an opening balance; OpeningBalance(Type), PeriodDebit, PeriodCredit" })
  async getTrialBalanceData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.ledgerReport(dto.orgId, "trialBalance", dto.from, dto.to));
  }

  @Get("getBankStatementData")
  @ApiOperation({ summary: "Bank / cash statement: payments in the range for one account (account) or all, oldest first (max 2000)" })
  async getBankStatementData(@Query() dto: BankStatementDto) {
    return ciSuccess(await this.reports.bankStatement(dto.orgId, dto.from, dto.to, dto.account));
  }

  @Get("getBankAccounts")
  @ApiOperation({ summary: "Active bank / cash accounts (Data: BankAccountUID, AccountName, BankName, IsCash), cash first" })
  async getBankAccounts(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.reports.bankAccounts(dto.orgId));
  }

  // ── Stock / item reports ──────────────────────────────────────────────────

  @Get("getItemWiseSalesData")
  @ApiOperation({ summary: "Item-wise sales per product: ProductUID, ItemName, SKU, CategoryName, UnitName, TotalQty, TotalValue, AvgPrice, InvoiceCount (max 1000)" })
  async getItemWiseSalesData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.itemTotals(dto.orgId, "sales", dto.from, dto.to));
  }

  @Get("getItemWisePurchaseData")
  @ApiOperation({ summary: "Item-wise purchases per product: ProductUID, ItemName, SKU, CategoryName, UnitName, TotalQty, TotalCost, AvgCost, BillCount (max 1000)" })
  async getItemWisePurchaseData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.itemTotals(dto.orgId, "purchase", dto.from, dto.to));
  }

  @Get("getBrandWiseSalesData")
  @ApiOperation({ summary: "Brand-wise sales: BrandUID, BrandName, ProductCount, InvoiceCount, TotalQty, TotalValue, AvgPrice (max 500)" })
  async getBrandWiseSalesData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.brandWiseSales(dto.orgId, dto.from, dto.to));
  }

  @Get("getLowStockAlertData")
  @ApiOperation({ summary: "Products at or below their low-stock level: AvailableQty, LowStockAlertAt, PurchasePrice, ShortfallQty (max 500)" })
  async getLowStockAlertData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.reports.stock(dto.orgId, "lowStock"));
  }

  @Get("getStockSummaryData")
  @ApiOperation({ summary: "Stock summary: every stocked product's AvailableQty, prices and StockValue (max 2000)" })
  async getStockSummaryData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.reports.stock(dto.orgId, "stockSummary"));
  }

  @Get("getVariantStockData")
  @ApiOperation({ summary: "Variant stock: VariantUID, ItemName, BrandName, SizeName, PartNumber, prices, StockQty, StockValue (max 2000)" })
  async getVariantStockData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.reports.stock(dto.orgId, "variantStock"));
  }

  // ── Party reports ─────────────────────────────────────────────────────────

  @Get("getCustomerOutstandingData")
  @ApiOperation({ summary: "Customers with open invoices: CustomerUID, CustomerName, MobileNumber, Area, InvoiceCount, TotalBilled, TotalPaid, TotalOutstanding (max 500)" })
  async getCustomerOutstandingData(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.reports.outstanding(dto.orgId, "C", dto.langCode));
  }

  @Get("getSupplierOutstandingData")
  @ApiOperation({ summary: "Suppliers with open purchase bills: VendorUID, VendorName, MobileNumber, Area, BillCount, TotalBilled, TotalPaid, TotalOutstanding (max 500)" })
  async getSupplierOutstandingData(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.reports.outstanding(dto.orgId, "S", dto.langCode));
  }

  @Get("getCustomerAgeingData")
  @ApiOperation({ summary: "Customer ageing: TotalOutstanding and Bucket0_30 / 31_60 / 61_90 / 91_120 / 120Plus by invoice age (max 500)" })
  async getCustomerAgeingData(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.reports.customerAgeing(dto.orgId, dto.langCode));
  }

  @Get("getCustomerLedgerData")
  @ApiOperation({ summary: "Customer ledger: rows (TxDate, TxType, RefNo, Debit, Credit) and opening { debit, credit }" })
  async getCustomerLedgerData(@Query() dto: CustomerLedgerDto) {
    return ciSuccess(await this.reports.ledger(dto.orgId, "C", Number(dto.customerUID) || 0, dto.from, dto.to));
  }

  @Get("getSupplierLedgerData")
  @ApiOperation({ summary: "Supplier ledger: rows (TxDate, TxType, RefNo, Debit, Credit) and opening { debit, credit }" })
  async getSupplierLedgerData(@Query() dto: SupplierLedgerDto) {
    return ciSuccess(await this.reports.ledger(dto.orgId, "S", Number(dto.vendorUID) || 0, dto.from, dto.to));
  }

  @Get("getExpenseRegisterData")
  @ApiOperation({ summary: "Expense register: DocNo, TransDate, VendorName, CategoryName, Amount, TaxAmount, NetAmount, DocStatus, IsPaid (max 2000)" })
  async getExpenseRegisterData(@Query() dto: ReportRangeDto) {
    return ciSuccess(await this.reports.expenseRegister(dto.orgId, dto.from, dto.to));
  }
}
