import { Injectable } from "@nestjs/common";
import { parseDateTime, phpDate } from "../../common/utils/php-compat";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { isIsoDate } from "../accounting/accounting-common";
import { todayIn } from "../hrms/hrms-common";
import { ExportResult, ExportService, ExportType } from "../../libraries/export/export.service";
import { GroupBy, ReportsRepository } from "./reports.repository";

const GROUP_BYS: GroupBy[] = ["month", "quarter", "year"];

// The document module and party behind each item-wise / register report (CI3 Reports_model wrappers)
const DOC_REPORTS = {
  invoice: { moduleUID: 103, partyType: "C" },
  purchase: { moduleUID: 105, partyType: "S" },
  salesReturn: { moduleUID: 106, partyType: "C" },
  purchaseReturn: { moduleUID: 108, partyType: "S" },
  deliveryChallan: { moduleUID: 112, partyType: "C" },
} as const;

export type ItemwiseReport = "invoice" | "purchase" | "salesReturn" | "purchaseReturn";
export type RegisterReport = "invoice" | "purchase" | "salesReturn" | "purchaseReturn" | "deliveryChallan";

/**
 * CI3 Reports controller data actions. Each answers like CI3 ({ Status: "Success", rows }), so the report pages
 * only change the URL; errors come back as { Error: true, Message } (the pages show Message when Status is not
 * "Success").
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly exporter: ExportService
  ) {}

  // from / to default to 1 January and today of the organisation's year (CI3: the server's date)
  private async range(orgUID: number, from: unknown, to: unknown): Promise<{ from: string; to: string }> {
    const today = todayIn((await this.orgSettings.get(orgUID)).Timezone);
    const result = { from: String(from || "") || `${today.slice(0, 4)}-01-01`, to: String(to || "") || today };
    if (!isIsoDate(result.from) || !isIsoDate(result.to)) throw new CiValidationError("Invalid date format.");
    return result;
  }

  private static groupBy(value: unknown): GroupBy {
    return GROUP_BYS.includes(value as GroupBy) ? (value as GroupBy) : "month";
  }

  private static ok(rows: unknown[]) {
    return { Status: "Success", rows };
  }

  // getSalesSummaryData — Invoice (103) and Sales Return (106) per period
  async salesSummary(orgUID: number, from: unknown, to: unknown, groupBy: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo.tradeSummary(orgUID, [103, 106], r.from, r.to, ReportsService.groupBy(groupBy)));
  }

  // getPurchaseSummaryData — Purchase (105) and Purchase Return (108) per period
  async purchaseSummary(orgUID: number, from: unknown, to: unknown, groupBy: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo.tradeSummary(orgUID, [105, 108], r.from, r.to, ReportsService.groupBy(groupBy)));
  }

  // getMonthlySummaryData — the calendar year's 103 / 105 / 106 / 108 totals per month
  async monthlySummary(orgUID: number, year: unknown) {
    const y = String(year || "") || todayIn((await this.orgSettings.get(orgUID)).Timezone).slice(0, 4);
    if (!/^\d{4}$/.test(y)) throw new CiValidationError("Invalid year.");
    return ReportsService.ok(await this.repo.monthlySummary(orgUID, `${y}-01-01`, `${y}-12-31`));
  }

  // getPaymentReceivedData — customer receipts in the range
  async paymentReceived(orgUID: number, from: unknown, to: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo.payments(orgUID, "C", r.from, r.to));
  }

  // getPaymentMadeData — vendor payments in the range
  async paymentMade(orgUID: number, from: unknown, to: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo.payments(orgUID, "S", r.from, r.to));
  }

  // get{Invoice,Purchase,SalesReturn,PurchaseReturn}ItemwiseData — every line of the module's documents in the range
  async itemwise(orgUID: number, report: ItemwiseReport, from: unknown, to: unknown) {
    const r = await this.range(orgUID, from, to);
    const { moduleUID, partyType } = DOC_REPORTS[report];
    return ReportsService.ok(await this.repo.billwiseItems(orgUID, moduleUID, partyType, r.from, r.to));
  }

  // get{Sales,Purchase,SalesReturn,PurchaseReturn,DeliveryChallan}RegisterData — one row per document with its tax breakup
  async register(orgUID: number, report: RegisterReport, from: unknown, to: unknown) {
    const r = await this.range(orgUID, from, to);
    const { moduleUID, partyType } = DOC_REPORTS[report];
    return ReportsService.ok(await this.repo.transRegister(orgUID, moduleUID, partyType, r.from, r.to));
  }

  // ── Tax reports ───────────────────────────────────────────────────────────

  // GSTR month / year: a bad or missing value falls back to the current month / year (as CI3 did)
  private async gstPeriod(orgUID: number, month: unknown, year: unknown) {
    const today = todayIn((await this.orgSettings.get(orgUID)).Timezone);
    const m = Number(month), y = Number(year);
    return {
      month: Number.isInteger(m) && m >= 1 && m <= 12 ? m : Number(today.slice(5, 7)),
      year: Number.isInteger(y) && y >= 2000 && y <= 2099 ? y : Number(today.slice(0, 4)),
    };
  }

  // GSTR-7 / HSN / TDS / TCS range: a bad or missing date falls back to the 1st of this month → today (as CI3 did)
  private async monthToDate(orgUID: number, from: unknown, to: unknown) {
    const today = todayIn((await this.orgSettings.get(orgUID)).Timezone);
    return { from: isIsoDate(from) ? from : `${today.slice(0, 7)}-01`, to: isIsoDate(to) ? to : today };
  }

  // getGstr1Data — B2B, B2CS and CDNR for the month
  async gstr1(orgUID: number, month: unknown, year: unknown) {
    const p = await this.gstPeriod(orgUID, month, year);
    return { Status: "Success", ...(await this.repo.gstr1(orgUID, p.month, p.year)) };
  }

  async exportGstr1(orgUID: number, month: unknown, year: unknown, section: string, type: ExportType): Promise<ExportResult> {
    const p = await this.gstPeriod(orgUID, month, year);
    const [data, settings, org] = await Promise.all([
      this.repo.gstr1(orgUID, p.month, p.year),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const monthName = new Date(p.year, p.month - 1, 1).toLocaleString("en-US", { month: "long" });
    const period = `${monthName} ${p.year}`;

    type GRow = Record<string, unknown>;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);

    let headers: string[];
    let rows: (string | number)[][];
    let previewName: string;
    let fileName: string;

    if (section === "b2cs") {
      headers = ["#", "Invoice No", "Date", "Customer Name", "Place of Supply", "Taxable", "CGST", "SGST", "IGST", "Total Tax", "Invoice Value"];
      rows = (data.b2cs as GRow[]).map((r, i) => [i + 1, String(r.InvNo || r.DocNo || ""), d(r.TransDate), String(r.CustomerName || ""), String(r.PlaceOfSupply || ""), n(r.Taxable), n(r.CgstAmount), n(r.SgstAmount), n(r.IgstAmount), n(r.TaxAmount), n(r.NetAmount)]);
      previewName = `GSTR-1 B2CS | ${period}`;
      fileName = `GSTR1_B2CS_${p.year}_${String(p.month).padStart(2, "0")}`;
    } else if (section === "cdnr") {
      headers = ["#", "Credit Note No", "Date", "Recipient GSTIN", "Recipient Name", "Taxable", "CGST", "SGST", "IGST", "Total Tax", "Note Value"];
      rows = (data.cdnr as GRow[]).map((r, i) => [i + 1, String(r.InvNo || r.DocNo || ""), d(r.TransDate), String(r.RecipientGSTIN || r.SupplierGSTIN || ""), String(r.RecipientName || r.SupplierName || ""), n(r.Taxable), n(r.CgstAmount), n(r.SgstAmount), n(r.IgstAmount), n(r.TaxAmount), n(r.NetAmount)]);
      previewName = `GSTR-1 CDNR | ${period}`;
      fileName = `GSTR1_CDNR_${p.year}_${String(p.month).padStart(2, "0")}`;
    } else {
      headers = ["#", "Invoice No", "Date", "Recipient GSTIN", "Recipient Name", "Place of Supply", "Taxable", "CGST", "SGST", "IGST", "Total Tax", "Invoice Value"];
      rows = (data.b2b as GRow[]).map((r, i) => [i + 1, String(r.InvNo || r.DocNo || ""), d(r.TransDate), String(r.RecipientGSTIN || r.SupplierGSTIN || ""), String(r.RecipientName || r.SupplierName || r.CustomerName || ""), String(r.PlaceOfSupply || ""), n(r.Taxable), n(r.CgstAmount), n(r.SgstAmount), n(r.IgstAmount), n(r.TaxAmount), n(r.NetAmount)]);
      previewName = `GSTR-1 B2B | ${period}`;
      fileName = `GSTR1_B2B_${p.year}_${String(p.month).padStart(2, "0")}`;
    }

    /* Last 6 columns are always the numeric ones (Taxable → Invoice/Note Value) */
    const numStart = headers.length - 6;
    const tots = new Array(6).fill(0) as number[];
    for (const r of rows) {
      for (let i = 0; i < 6; i++) tots[i] += parseFloat(String(r[numStart + i])) || 0;
    }
    const totalRow: (string | number)[] = [...new Array(numStart).fill("")];
    totalRow[1] = "Total";
    tots.forEach((t) => totalRow.push(t.toFixed(2)));

    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows, org, timezone: tz, totalRow });
  }

  // getGstr2bData — purchase bills from GSTIN vendors for the month
  async gstr2b(orgUID: number, month: unknown, year: unknown) {
    const p = await this.gstPeriod(orgUID, month, year);
    return ReportsService.ok(await this.repo.gstr2b(orgUID, p.month, p.year));
  }

  async exportGstr2b(orgUID: number, month: unknown, year: unknown, type: ExportType): Promise<ExportResult> {
    const p = await this.gstPeriod(orgUID, month, year);
    const [rows, settings, org] = await Promise.all([
      this.repo.gstr2b(orgUID, p.month, p.year),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const monthName = new Date(p.year, p.month - 1, 1).toLocaleString("en-US", { month: "long" });
    const period = `${monthName} ${p.year}`;
    const fileName = `GSTR2B_${p.year}_${String(p.month).padStart(2, "0")}`;
    const previewName = `GSTR-2B | ${period}`;

    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);

    type GRow = Record<string, unknown>;
    const headers = ["#", "Bill No", "Date", "Supplier GSTIN", "Supplier Name", "Place of Supply", "Taxable", "CGST", "SGST", "IGST", "Total ITC", "Bill Value"];
    const dataRows = (rows as GRow[]).map((r, i) => [
      i + 1, String(r.BillNo || ""), d(r.TransDate), String(r.SupplierGSTIN || ""),
      String(r.SupplierName || ""), String(r.PlaceOfSupply || ""),
      n(r.Taxable), n(r.CgstAmount), n(r.SgstAmount), n(r.IgstAmount), n(r.TaxAmount), n(r.NetAmount),
    ]) as (string | number)[][];

    /* Last 6 columns are numeric (Taxable → Bill Value) */
    const numStart = headers.length - 6;
    const tots = new Array(6).fill(0) as number[];
    for (const r of dataRows) {
      for (let i = 0; i < 6; i++) tots[i] += parseFloat(String(r[numStart + i])) || 0;
    }
    const totalRow: (string | number)[] = [...new Array(numStart).fill("")];
    totalRow[1] = "Total";
    tots.forEach((t) => totalRow.push(t.toFixed(2)));

    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  // getGstr3bData — outward and ITC totals for the month
  async gstr3b(orgUID: number, month: unknown, year: unknown) {
    const p = await this.gstPeriod(orgUID, month, year);
    return { Status: "Success", ...(await this.repo.gstr3b(orgUID, p.month, p.year)) };
  }

  async exportGstr3b(orgUID: number, month: unknown, year: unknown, type: ExportType): Promise<ExportResult> {
    const p = await this.gstPeriod(orgUID, month, year);
    const [data, settings, org] = await Promise.all([
      this.repo.gstr3b(orgUID, p.month, p.year),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const monthName = new Date(p.year, p.month - 1, 1).toLocaleString("en-US", { month: "long" });
    const period = `${monthName} ${p.year}`;
    const fileName = `GSTR3B_${p.year}_${String(p.month).padStart(2, "0")}`;
    const previewName = `GSTR-3B Summary | ${period}`;

    type R = Record<string, unknown>;
    const outward = (data.outward || {}) as R;
    const itc     = (data.itc     || {}) as R;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    const salesCgst   = parseFloat(String(outward.SalesCgst   ?? 0)) || 0;
    const salesSgst   = parseFloat(String(outward.SalesSgst   ?? 0)) || 0;
    const salesIgst   = parseFloat(String(outward.SalesIgst   ?? 0)) || 0;
    const returnTax   = parseFloat(String(outward.ReturnTax   ?? 0)) || 0;
    const purchaseCgst = parseFloat(String(itc.PurchaseCgst ?? 0)) || 0;
    const purchaseSgst = parseFloat(String(itc.PurchaseSgst ?? 0)) || 0;
    const purchaseIgst = parseFloat(String(itc.PurchaseIgst ?? 0)) || 0;
    const prCgst   = parseFloat(String(itc.PRCgst ?? 0)) || 0;
    const prSgst   = parseFloat(String(itc.PRSgst ?? 0)) || 0;
    const prIgst   = parseFloat(String(itc.PRIgst ?? 0)) || 0;
    const netItcCgst  = purchaseCgst - prCgst;
    const netItcSgst  = purchaseSgst - prSgst;
    const netItcIgst  = purchaseIgst - prIgst;
    const netItcTotal = netItcCgst + netItcSgst + netItcIgst;
    const liabCgst  = Math.max(0, salesCgst - netItcCgst);
    const liabSgst  = Math.max(0, salesSgst - netItcSgst);
    const liabIgst  = Math.max(0, salesIgst - netItcIgst);
    const liabTotal = liabCgst + liabSgst + liabIgst;

    const headers = ["Section", "Description", "Count", "Taxable Amount", "CGST", "SGST", "IGST", "Total Tax"];
    /* Rows — section header rows use empty string for numeric cols so they don't roll into totals */
    const rows: (string | number)[][] = [
      ["3.1", "Outward Taxable Supplies", String(outward.SalesCount ?? ""), n(outward.SalesTaxable), n(salesCgst), n(salesSgst), n(salesIgst), n(outward.SalesTax)],
      ["",    "Less: Sales Returns (Credit Notes)", String(outward.ReturnCount ?? ""), n(outward.ReturnTaxable), "—", "—", "—", n(returnTax)],
      ["",    "Net Outward Supplies", "", n((parseFloat(String(outward.SalesTaxable ?? 0)) || 0) - (parseFloat(String(outward.ReturnTaxable ?? 0)) || 0)), n(salesCgst), n(salesSgst), n(salesIgst), n((parseFloat(String(outward.SalesTax ?? 0)) || 0) - returnTax)],
      ["4",   "ITC — Purchases from GSTIN Suppliers", String(itc.PurchaseCount ?? ""), n(itc.PurchaseTaxable), n(purchaseCgst), n(purchaseSgst), n(purchaseIgst), n(itc.PurchaseTax)],
      ["",    "Less: Purchase Returns", "", "", n(prCgst), n(prSgst), n(prIgst), n(prCgst + prSgst + prIgst)],
      ["",    "Net ITC Available", "", n(itc.PurchaseTaxable), n(netItcCgst), n(netItcSgst), n(netItcIgst), n(netItcTotal)],
      ["6",   "Net Tax Payable — CGST", "", "", n(liabCgst), "", "", ""],
      ["",    "Net Tax Payable — SGST", "", "", "", n(liabSgst), "", ""],
      ["",    "Net Tax Payable — IGST", "", "", "", "", n(liabIgst), ""],
      ["",    "Total Net Tax Payable", "", "", n(liabCgst), n(liabSgst), n(liabIgst), n(liabTotal)],
    ];

    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows, org, timezone: tz });
  }

  /**
   * getGstr7Data / getTdsPayableData (expenses with TDS), getHsnData, getTdsReceivableData. CI3's TDS receivable /
   * payable actions called an unloaded model ($this->Reports_model) and always failed.
   */
  async taxRange(orgUID: number, report: "tdsExpenses" | "hsnSummary" | "tdsReceivable", from: unknown, to: unknown) {
    const r = await this.monthToDate(orgUID, from, to);
    return ReportsService.ok(await this.repo[report](orgUID, r.from, r.to));
  }

  // getTcsReceivableData / getTcsPayableData — TCS is not tracked yet, so always empty (as CI3)
  tcs() {
    return ReportsService.ok([]);
  }

  // getPLStatementData / getTrialBalanceData — ledger totals for the range
  async ledgerReport(orgUID: number, report: "plStatement" | "trialBalance", from: unknown, to: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo[report](orgUID, r.from, r.to));
  }

  // getBalanceSheetData — ledger totals up to a date (default today)
  async balanceSheet(orgUID: number, asOf: unknown) {
    const date = String(asOf || "") || todayIn((await this.orgSettings.get(orgUID)).Timezone);
    if (!isIsoDate(date)) throw new CiValidationError("Invalid date format.");
    return ReportsService.ok(await this.repo.balanceSheet(orgUID, date));
  }

  // getBankStatementData — payments in the range for one account (0 = all)
  async bankStatement(orgUID: number, from: unknown, to: unknown, accountUID: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo.bankStatement(orgUID, r.from, r.to, Number(accountUID) || 0));
  }

  // getBankAccounts — the bank statement page's account list
  async bankAccounts(orgUID: number) {
    return { Data: await this.repo.bankAccounts(orgUID) };
  }

  /**
   * getDayBookData — the day's documents and payments ({ Status, entries }); EntryTime (stored in UTC) is shown as
   * the organisation's H:i:s. CI3 called api/transactions/getDayBookEntries, which did not exist, so it was empty.
   */
  async dayBook(orgUID: number, date: unknown) {
    const timezone = (await this.orgSettings.get(orgUID)).Timezone;
    const day = String(date || "") || todayIn(timezone);
    if (!isIsoDate(day)) throw new CiValidationError("Invalid date format.");
    const entries = (await this.repo.dayBook(orgUID, day)).map((entry) => {
      const at = parseDateTime(String(entry.EntryTime ?? ""));
      return at ? { ...entry, EntryTime: phpDate("H:i:s", at, timezone) } : entry;
    });
    return { Status: "Success", entries };
  }

  // getItemWiseSalesData / getItemWisePurchaseData — totals per product in the range
  async itemTotals(orgUID: number, kind: "sales" | "purchase", from: unknown, to: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo.itemTotals(orgUID, kind, r.from, r.to));
  }

  // getBrandWiseSalesData — invoice totals per brand in the range
  async brandWiseSales(orgUID: number, from: unknown, to: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo.brandWiseSales(orgUID, r.from, r.to));
  }

  // getLowStockAlertData / getStockSummaryData / getVariantStockData — current stock (no date range)
  async stock(orgUID: number, report: "lowStock" | "stockSummary" | "variantStock") {
    return ReportsService.ok(await this.repo[report](orgUID));
  }

  // getCustomerOutstandingData / getSupplierOutstandingData — parties with open invoices / bills
  async outstanding(orgUID: number, party: "C" | "S", langCode: string) {
    return ReportsService.ok(await this.repo.outstanding(orgUID, party, langCode));
  }

  // getCustomerAgeingData — open invoice balances in age buckets
  async customerAgeing(orgUID: number, langCode: string) {
    return ReportsService.ok(await this.repo.outstanding(orgUID, "C", langCode, true));
  }

  // get{Customer,Supplier}LedgerData — the range's entries plus the opening balance before it
  async ledger(orgUID: number, party: "C" | "S", partyUID: number, from: unknown, to: unknown) {
    if (!(partyUID > 0)) throw new CiValidationError(party === "C" ? "Please select a customer." : "Please select a supplier.");
    const r = await this.range(orgUID, from, to);
    const [rows, opening] = await Promise.all([this.repo.ledger(orgUID, party, partyUID, r.from, r.to), this.repo.ledgerOpening(orgUID, party, partyUID, r.from)]);
    return { ...ReportsService.ok(rows), opening };
  }

  // exportCustomerLedger / exportSupplierLedger — same data as ledger() built into Print/CSV/Excel
  async exportLedger(orgUID: number, party: "C" | "S", partyUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    if (!(partyUID > 0)) throw new CiValidationError(party === "C" ? "Please select a customer." : "Please select a supplier.");
    const r = await this.range(orgUID, from, to);
    const [rows, opening, settings, org] = await Promise.all([
      this.repo.ledger(orgUID, party, partyUID, r.from, r.to),
      this.repo.ledgerOpening(orgUID, party, partyUID, r.from),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);

    const dateFormat = settings.ListDateTimeFormat ?? "d M Y";
    const tz = settings.Timezone || "UTC";
    const obDebit  = Number((opening as Record<string, unknown>).debit  ?? 0);
    const obCredit = Number((opening as Record<string, unknown>).credit ?? 0);

    /* Customer ledger: balance = Debit – Credit (invoices ↑, payments ↓) */
    let runBal = party === "C" ? obDebit - obCredit : obCredit - obDebit;

    const exportRows: (string | number)[][] = [];
    let rowNum = 0;
    let totDebit = 0, totCredit = 0;

    if (obDebit > 0.005 || obCredit > 0.005) {
      rowNum++;
      exportRows.push([
        rowNum,
        "—",
        "Opening Balance",
        "Opening Balance",
        obDebit  > 0.005 ? obDebit.toFixed(2)  : "",
        obCredit > 0.005 ? obCredit.toFixed(2) : "",
        Math.abs(runBal).toFixed(2) + (runBal < 0 ? " Cr" : " Dr"),
      ]);
    }

    for (const row of rows as Record<string, unknown>[]) {
      rowNum++;
      const dr = Number(row.Debit  ?? 0);
      const cr = Number(row.Credit ?? 0);
      runBal   += party === "C" ? dr - cr : cr - dr;
      totDebit  += dr;
      totCredit += cr;
      const txDate = row.TxDate ? phpDate(dateFormat, new Date(String(row.TxDate) + "T00:00:00"), tz) : "—";
      exportRows.push([
        rowNum,
        txDate,
        String(row.TxType || ""),
        String(row.RefNo  || "—"),
        dr > 0.005 ? dr.toFixed(2) : "",
        cr > 0.005 ? cr.toFixed(2) : "",
        Math.abs(runBal).toFixed(2) + (runBal < 0 ? " Cr" : " Dr"),
      ]);
    }

    /* Stats summary (matches the 4 cards on the page) */
    const obBal   = party === "C" ? obDebit - obCredit : obCredit - obDebit;
    const obAbs   = Math.abs(obBal);
    const obSide  = obBal >= 0 ? (party === "C" ? " Dr" : " Cr") : (party === "C" ? " Cr" : " Dr");
    const clsAbs  = Math.abs(runBal);
    const clsSide = runBal >= 0 ? (party === "C" ? " Dr" : " Cr") : (party === "C" ? " Cr" : " Dr");
    const summaryItems = [
      { label: "Opening Balance",         value: obAbs.toFixed(2) + obSide },
      { label: party === "C" ? "Total Debit (Invoices)" : "Total Credit (Bills)", value: (party === "C" ? totDebit : totCredit).toFixed(2) },
      { label: party === "C" ? "Total Credit (Payments)" : "Total Debit (Payments)", value: (party === "C" ? totCredit : totDebit).toFixed(2) },
      { label: "Closing Balance",         value: clsAbs.toFixed(2) + clsSide },
    ];

    /* Total row for the table footer */
    const totalRow: (string | number)[] = ["", "Total", "", "", totDebit.toFixed(2), totCredit.toFixed(2), clsAbs.toFixed(2) + clsSide];

    const partyLabel = party === "C" ? "Customer" : "Supplier";
    return this.exporter.build({
      type,
      fileName: `${partyLabel}_Ledger`,
      sheetName: `${partyLabel} Ledger`,
      previewName: `${partyLabel} Ledger | ${r.from} to ${r.to}`,
      headers: ["#", "Date", "Type", "Ref No", "Debit", "Credit", "Balance"],
      rows: exportRows,
      org,
      timezone: tz,
      colWidths: ["4%", "10%", "14%", "12%", "14%", "14%", "12%"],
      summaryItems,
      totalRow,
    });
  }

  // getExpenseRegisterData — committed expenses in the range
  async expenseRegister(orgUID: number, from: unknown, to: unknown) {
    const r = await this.range(orgUID, from, to);
    return ReportsService.ok(await this.repo.expenseRegister(orgUID, r.from, r.to));
  }

  async exportRegister(orgUID: number, report: string, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const reg = report as RegisterReport;
    const { moduleUID, partyType } = DOC_REPORTS[reg] ?? DOC_REPORTS.invoice;
    const [rows, settings, org] = await Promise.all([
      this.repo.transRegister(orgUID, moduleUID, partyType, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const labels: Record<string, [string, string]> = {
      invoice: ["Sales_Register", "Sales Register"],
      purchase: ["Purchase_Register", "Purchase Register"],
      salesReturn: ["Sales_Return_Register", "Sales Return Register"],
      purchaseReturn: ["Purchase_Return_Register", "Purchase Return Register"],
      deliveryChallan: ["Delivery_Challan_Register", "Delivery Challan Register"],
    };
    const [fileLabel, printLabel] = labels[reg] ?? ["Register", "Register"];
    const fileName = `${fileLabel}_${r.from}_${r.to}`;
    const previewName = `${printLabel} | ${r.from} to ${r.to}`;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Doc No", "Date", "Party Name", "Taxable", "CGST", "SGST", "IGST", "Tax Amount", "Net Amount", "Status"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.DocNo || ""), d(row.TransDate), String(row.PartyName || ""), n(row.Taxable), n(row.CgstAmount), n(row.SgstAmount), n(row.IgstAmount), n(row.TaxAmount), n(row.NetAmount), String(row.DocStatus || "")]) as (string | number)[][];
    const tots = Array(6).fill(0) as number[];
    for (const row of dataRows) for (let i = 0; i < 6; i++) tots[i] += parseFloat(String(row[4 + i])) || 0;
    const totalRow: (string | number)[] = ["", "Total", "", "", ...tots.map((t) => t.toFixed(2)), ""];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportTdsExpense(orgUID: number, label: "GSTR7" | "TDSPayable", from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.monthToDate(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.tdsExpenses(orgUID, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileLabel = label === "GSTR7" ? "GSTR7" : "TDS_Payable";
    const printLabel = label === "GSTR7" ? "GSTR-7 (TDS Deducted)" : "TDS Payable";
    const fileName = `${fileLabel}_${r.from}_${r.to}`;
    const previewName = `${printLabel} | ${r.from} to ${r.to}`;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Doc No", "Date", "Vendor Name", "Vendor GSTIN", "TDS Section", "TDS Description", "Base Amount", "TDS %", "TDS Amount", "Net Amount", "Status"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.DocNo || ""), d(row.TransDate), String(row.VendorName || ""), String(row.VendorGSTIN || ""), String(row.TdsSection || ""), String(row.TdsSectionDesc || ""), n(row.BaseAmount), n(row.TdsPct), n(row.TdsAmount), n(row.NetAmount), String(row.DocStatus || "")]) as (string | number)[][];
    const totBase = dataRows.reduce((a, row) => a + (parseFloat(String(row[7])) || 0), 0);
    const totTds  = dataRows.reduce((a, row) => a + (parseFloat(String(row[9])) || 0), 0);
    const totNet  = dataRows.reduce((a, row) => a + (parseFloat(String(row[10])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", "", "", "", totBase.toFixed(2), "", totTds.toFixed(2), totNet.toFixed(2), ""];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportTdsReceivable(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.monthToDate(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.tdsReceivable(orgUID, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `TDS_Receivable_${r.from}_${r.to}`;
    const previewName = `TDS Receivable | ${r.from} to ${r.to}`;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Invoice No", "Date", "Customer Name", "Customer GSTIN", "Taxable", "Tax Amount", "Invoice Value", "Status"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.InvNo || ""), d(row.TransDate), String(row.CustomerName || ""), String(row.CustomerGSTIN || ""), n(row.Taxable), n(row.TaxAmount), n(row.NetAmount), String(row.DocStatus || "")]) as (string | number)[][];
    const tots = [0, 0, 0];
    for (const row of dataRows) { tots[0] += parseFloat(String(row[5])) || 0; tots[1] += parseFloat(String(row[6])) || 0; tots[2] += parseFloat(String(row[7])) || 0; }
    const totalRow: (string | number)[] = ["", "Total", "", "", "", tots[0].toFixed(2), tots[1].toFixed(2), tots[2].toFixed(2), ""];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportHsnSummary(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.monthToDate(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.hsnSummary(orgUID, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `HSN_Summary_${r.from}_${r.to}`;
    const previewName = `Sale Summary by HSN | ${r.from} to ${r.to}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "HSN Code", "UOM", "Tax Rate %", "Total Qty", "Taxable Value", "CGST", "SGST", "IGST", "Tax Amount", "Invoice Count"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.HsnCode || ""), String(row.UOM || ""), n(row.TaxRate), n(row.TotalQty), n(row.TaxableValue), n(row.CgstAmount), n(row.SgstAmount), n(row.IgstAmount), n(row.TaxAmount), parseInt(String(row.InvCount ?? 0), 10) || 0]) as (string | number)[][];
    const tots = Array(7).fill(0) as number[];
    for (const row of dataRows) for (let i = 0; i < 7; i++) tots[i] += parseFloat(String(row[4 + i])) || 0;
    const totalRow: (string | number)[] = ["", "Total", "", "", ...tots.map((t, i) => i === 6 ? Math.round(t) : t.toFixed(2))];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportItemwise(orgUID: number, report: string, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const reg = report as ItemwiseReport;
    const { moduleUID, partyType } = DOC_REPORTS[reg] ?? DOC_REPORTS.invoice;
    const [rows, settings, org] = await Promise.all([
      this.repo.billwiseItems(orgUID, moduleUID, partyType, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const labels: Record<string, [string, string]> = {
      invoice: ["Invoice_Itemwise", "Invoice Item-wise"],
      purchase: ["Purchase_Itemwise", "Purchase Item-wise"],
      salesReturn: ["Sales_Return_Itemwise", "Sales Return Item-wise"],
      purchaseReturn: ["Purchase_Return_Itemwise", "Purchase Return Item-wise"],
    };
    const [fileLabel, printLabel] = labels[reg] ?? ["Itemwise", "Item-wise"];
    const fileName = `${fileLabel}_${r.from}_${r.to}`;
    const previewName = `${printLabel} | ${r.from} to ${r.to}`;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Doc No", "Date", "Party", "Item", "Qty", "Unit", "Unit Price", "Taxable", "Tax %", "Tax Amount", "Net Amount"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.DocNo || ""), d(row.TransDate), String(row.PartyName || ""), String(row.ItemName || ""), n(row.Quantity), String(row.UnitName || ""), n(row.UnitPrice), n(row.TaxableAmount), n(row.TaxPercentage), n(row.TaxAmount), n(row.NetAmount)]) as (string | number)[][];
    const tots = [0, 0, 0, 0];
    for (const row of dataRows) { tots[0] += parseFloat(String(row[8])) || 0; tots[1] += parseFloat(String(row[10])) || 0; tots[2] += parseFloat(String(row[11])) || 0; }
    const totalRow: (string | number)[] = ["", "Total", "", "", "", "", "", "", tots[0].toFixed(2), "", tots[1].toFixed(2), tots[2].toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportItemWiseSales(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.itemTotals(orgUID, "sales", r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Item_Wise_Sales_${r.from}_${r.to}`;
    const previewName = `Item Wise Sales | ${r.from} to ${r.to}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Item Name", "SKU", "Category", "Unit", "Invoice Count", "Total Qty", "Avg Price", "Total Value"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.ItemName || ""), String(row.SKU || ""), String(row.CategoryName || ""), String(row.UnitName || ""), parseInt(String(row.InvoiceCount ?? 0), 10) || 0, n(row.TotalQty), n(row.AvgPrice), n(row.TotalValue)]) as (string | number)[][];
    const totQty = dataRows.reduce((a, row) => a + (parseFloat(String(row[6])) || 0), 0);
    const totVal = dataRows.reduce((a, row) => a + (parseFloat(String(row[8])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", "", dataRows.length, totQty.toFixed(2), "", totVal.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportItemWisePurchase(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.itemTotals(orgUID, "purchase", r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Item_Wise_Purchase_${r.from}_${r.to}`;
    const previewName = `Item Wise Purchase | ${r.from} to ${r.to}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Item Name", "SKU", "Category", "Unit", "Bill Count", "Total Qty", "Avg Cost", "Total Cost"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.ItemName || ""), String(row.SKU || ""), String(row.CategoryName || ""), String(row.UnitName || ""), parseInt(String(row.BillCount ?? 0), 10) || 0, n(row.TotalQty), n(row.AvgCost), n(row.TotalCost)]) as (string | number)[][];
    const totQty = dataRows.reduce((a, row) => a + (parseFloat(String(row[6])) || 0), 0);
    const totCost = dataRows.reduce((a, row) => a + (parseFloat(String(row[8])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", "", dataRows.length, totQty.toFixed(2), "", totCost.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportBrandWiseSales(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.brandWiseSales(orgUID, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Brand_Wise_Sales_${r.from}_${r.to}`;
    const previewName = `Brand Wise Sales | ${r.from} to ${r.to}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Brand", "Products", "Invoices", "Total Qty", "Avg Price", "Total Value"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.BrandName || ""), parseInt(String(row.ProductCount ?? 0), 10) || 0, parseInt(String(row.InvoiceCount ?? 0), 10) || 0, n(row.TotalQty), n(row.AvgPrice), n(row.TotalValue)]) as (string | number)[][];
    const totVal = dataRows.reduce((a, row) => a + (parseFloat(String(row[6])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", "", "", totVal.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportLowStockAlert(orgUID: number, type: ExportType): Promise<ExportResult> {
    const [rows, settings, org] = await Promise.all([
      this.repo.lowStock(orgUID),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = "Low_Stock_Alert";
    const previewName = "Low Stock Alert";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Product", "SKU", "Category", "Unit", "In Stock", "Threshold", "Shortfall"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.ItemName || ""), String(row.SKU || ""), String(row.CategoryName || ""), String(row.UnitName || ""), n(row.AvailableQty), n(row.LowStockAlertAt), n(row.ShortfallQty)]) as (string | number)[][];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz });
  }

  async exportStockSummary(orgUID: number, type: ExportType): Promise<ExportResult> {
    const [rows, settings, org] = await Promise.all([
      this.repo.stockSummary(orgUID),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = "Stock_Summary";
    const previewName = "Stock Summary";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Product", "SKU", "Category", "Unit", "Available Qty", "Purchase Price", "Selling Price", "Stock Value"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.ItemName || ""), String(row.SKU || ""), String(row.CategoryName || ""), String(row.UnitName || ""), n(row.AvailableQty), n(row.PurchasePrice), n(row.SellingPrice), n(row.StockValue)]) as (string | number)[][];
    const totVal = dataRows.reduce((a, row) => a + (parseFloat(String(row[8])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", "", "", "", "", totVal.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportVariantStock(orgUID: number, type: ExportType): Promise<ExportResult> {
    const [rows, settings, org] = await Promise.all([
      this.repo.variantStock(orgUID),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = "Variant_Stock";
    const previewName = "Variant Stock";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Brand", "Size", "Product", "Part No", "Purchase Price", "Selling Price", "Stock Qty", "Stock Value"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.BrandName || ""), String(row.SizeName || ""), String(row.ItemName || ""), String(row.PartNumber || ""), n(row.PurchasePrice), n(row.SellingPrice), n(row.StockQty), n(row.StockValue)]) as (string | number)[][];
    const totVal = dataRows.reduce((a, row) => a + (parseFloat(String(row[8])) || 0), 0);
    const totalRow: (string | number)[] = ["", "", "", "Total", "", "", "", "", totVal.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportCustomerOutstanding(orgUID: number, type: ExportType): Promise<ExportResult> {
    const [rows, settings, org] = await Promise.all([
      this.repo.outstanding(orgUID, "C", "en"),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = "Customer_Outstanding";
    const previewName = "Customer Outstanding";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Customer", "Mobile", "Area", "Invoices", "Total Billed", "Total Paid", "Outstanding"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.CustomerName || ""), String(row.MobileNumber || ""), String(row.Area || ""), parseInt(String(row.InvoiceCount ?? 0), 10) || 0, n(row.TotalBilled), n(row.TotalPaid), n(row.TotalOutstanding)]) as (string | number)[][];
    const totOut = dataRows.reduce((a, row) => a + (parseFloat(String(row[7])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", dataRows.length, "", "", totOut.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportSupplierOutstanding(orgUID: number, type: ExportType): Promise<ExportResult> {
    const [rows, settings, org] = await Promise.all([
      this.repo.outstanding(orgUID, "S", "en"),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = "Supplier_Outstanding";
    const previewName = "Supplier Outstanding";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Supplier", "Mobile", "Area", "Bills", "Total Billed", "Total Paid", "Outstanding"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.VendorName || ""), String(row.MobileNumber || ""), String(row.Area || ""), parseInt(String(row.BillCount ?? 0), 10) || 0, n(row.TotalBilled), n(row.TotalPaid), n(row.TotalOutstanding)]) as (string | number)[][];
    const totOut = dataRows.reduce((a, row) => a + (parseFloat(String(row[7])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", dataRows.length, "", "", totOut.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportCustomerAgeing(orgUID: number, type: ExportType): Promise<ExportResult> {
    const [rows, settings, org] = await Promise.all([
      this.repo.outstanding(orgUID, "C", "en", true),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = "Customer_Ageing";
    const previewName = "Customer Ageing";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Customer", "Mobile", "Area", "0-30 Days", "31-60 Days", "61-90 Days", "91-120 Days", "120+ Days", "Total"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.CustomerName || ""), String(row.MobileNumber || ""), String(row.Area || ""), n(row.Bucket0_30), n(row.Bucket31_60), n(row.Bucket61_90), n(row.Bucket91_120), n(row.Bucket120Plus), n(row.TotalOutstanding)]) as (string | number)[][];
    const tots = [0, 0, 0, 0, 0, 0];
    for (const row of dataRows) for (let i = 0; i < 6; i++) tots[i] += parseFloat(String(row[4 + i])) || 0;
    const totalRow: (string | number)[] = ["", "Total", "", "", ...tots.map((t) => t.toFixed(2))];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportExpenseRegister(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.expenseRegister(orgUID, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Expense_Register_${r.from}_${r.to}`;
    const previewName = `Expense Register | ${r.from} to ${r.to}`;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Doc No", "Date", "Vendor Name", "Category", "Amount", "Tax Amount", "Net Amount", "Paid", "Status"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.DocNo || ""), d(row.TransDate), String(row.VendorName || ""), String(row.CategoryName || ""), n(row.Amount), n(row.TaxAmount), n(row.NetAmount), row.IsPaid ? "Yes" : "No", String(row.DocStatus || "")]) as (string | number)[][];
    const tots = [0, 0, 0];
    for (const row of dataRows) { tots[0] += parseFloat(String(row[5])) || 0; tots[1] += parseFloat(String(row[6])) || 0; tots[2] += parseFloat(String(row[7])) || 0; }
    const totalRow: (string | number)[] = ["", "Total", "", "", "", tots[0].toFixed(2), tots[1].toFixed(2), tots[2].toFixed(2), "", ""];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportPLStatement(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.plStatement(orgUID, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `PL_Statement_${r.from}_${r.to}`;
    const previewName = `P&L Statement | ${r.from} to ${r.to}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Account", "Type", "Period Dr", "Period Cr", "Net Amount"];
    const dataRows = (rows as GRow[]).map((row, i) => {
      const dr = parseFloat(String(row.PeriodDebit ?? 0)) || 0;
      const cr = parseFloat(String(row.PeriodCredit ?? 0)) || 0;
      const net = row.LedgerType === "Income" ? cr - dr : dr - cr;
      return [i + 1, String(row.LedgerName || ""), String(row.LedgerType || ""), n(dr), n(cr), n(net)];
    }) as (string | number)[][];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz });
  }

  async exportBalanceSheet(orgUID: number, asOf: unknown, type: ExportType): Promise<ExportResult> {
    const settings = await this.orgSettings.get(orgUID);
    const date = String(asOf || "") || todayIn(settings.Timezone);
    const [rows, org] = await Promise.all([
      this.repo.balanceSheet(orgUID, date),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Balance_Sheet_${date}`;
    const previewName = `Balance Sheet | As of ${date}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Account", "Type", "Opening Balance", "Opening Type", "Period Dr", "Period Cr"];
    const dataRows = (rows as GRow[]).map((row, i) => [i + 1, String(row.LedgerName || ""), String(row.LedgerType || ""), n(row.OpeningBalance), String(row.OpeningBalanceType || ""), n(row.TotalDebit), n(row.TotalCredit)]) as (string | number)[][];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz });
  }

  async exportTrialBalance(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.trialBalance(orgUID, r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Trial_Balance_${r.from}_${r.to}`;
    const previewName = `Trial Balance | ${r.from} to ${r.to}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["#", "Code", "Account", "Type", "Opening Dr", "Opening Cr", "Period Dr", "Period Cr", "Closing Dr", "Closing Cr"];
    const dataRows = (rows as GRow[]).map((row, i) => {
      const ob = parseFloat(String(row.OpeningBalance ?? 0)) || 0;
      const obT = String(row.OpeningBalanceType || "Debit");
      const pDr = parseFloat(String(row.PeriodDebit ?? 0)) || 0;
      const pCr = parseFloat(String(row.PeriodCredit ?? 0)) || 0;
      const net = ob + (obT === "Debit" ? pDr - pCr : pCr - pDr);
      const closeT = net >= 0 ? obT : (obT === "Debit" ? "Credit" : "Debit");
      const closeBal = Math.abs(net);
      return [i + 1, String(row.LedgerCode || ""), String(row.LedgerName || ""), String(row.LedgerType || ""), obT === "Debit" ? n(ob) : "0.00", obT === "Credit" ? n(ob) : "0.00", n(pDr), n(pCr), closeT === "Debit" ? n(closeBal) : "0.00", closeT === "Credit" ? n(closeBal) : "0.00"];
    }) as (string | number)[][];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz });
  }

  async exportPaymentReceived(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.payments(orgUID, "C", r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Payment_Received_${r.from}_${r.to}`;
    const previewName = `Payment Received | ${r.from} to ${r.to}`;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["Date", "Receipt No", "Customer", "Mode", "Account", "Reference", "Amount"];
    const dataRows = (rows as GRow[]).map((row) => [d(row.PaymentDate), String(row.UniqueNumber || ""), String(row.PartyName || ""), String(row.PaymentMode || ""), String(row.AccountName || ""), String(row.ReferenceNo || ""), n(row.Amount)]) as (string | number)[][];
    const totAmt = dataRows.reduce((a, row) => a + (parseFloat(String(row[6])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", "", "", totAmt.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportPaymentMade(orgUID: number, from: unknown, to: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.payments(orgUID, "S", r.from, r.to),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Payment_Made_${r.from}_${r.to}`;
    const previewName = `Payment Made | ${r.from} to ${r.to}`;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["Date", "Payment No", "Supplier", "Mode", "Account", "Reference", "Amount"];
    const dataRows = (rows as GRow[]).map((row) => [d(row.PaymentDate), String(row.UniqueNumber || ""), String(row.PartyName || ""), String(row.PaymentMode || ""), String(row.AccountName || ""), String(row.ReferenceNo || ""), n(row.Amount)]) as (string | number)[][];
    const totAmt = dataRows.reduce((a, row) => a + (parseFloat(String(row[6])) || 0), 0);
    const totalRow: (string | number)[] = ["", "Total", "", "", "", "", totAmt.toFixed(2)];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz, totalRow });
  }

  async exportBankStatement(orgUID: number, from: unknown, to: unknown, accountUID: unknown, type: ExportType): Promise<ExportResult> {
    const r = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.bankStatement(orgUID, r.from, r.to, Number(accountUID) || 0),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Bank_Statement_${r.from}_${r.to}`;
    const previewName = `Bank Statement | ${r.from} to ${r.to}`;
    const d = (v: unknown) => v ? new Date(String(v) + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const headers = ["Date", "Doc No", "Party", "Type", "Mode", "Account", "Credit (In)", "Debit (Out)"];
    const dataRows = (rows as GRow[]).map((row) => {
      const isIn = row.PartyType === "C";
      const amt = parseFloat(String(row.Amount ?? 0)) || 0;
      return [d(row.PaymentDate), String(row.UniqueNumber || ""), String(row.PartyName || ""), isIn ? "Receipt" : "Payment", String(row.PaymentMode || ""), String(row.AccountName || ""), isIn ? n(amt) : "—", isIn ? "—" : n(amt)];
    }) as (string | number)[][];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz });
  }

  async exportSalesSummary(orgUID: number, from: unknown, to: unknown, groupBy: unknown, type: ExportType): Promise<ExportResult> {
    const rng = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.tradeSummary(orgUID, [103, 106], rng.from, rng.to, ReportsService.groupBy(groupBy)),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Sales_Summary_${rng.from}_${rng.to}`;
    const previewName = `Sales Summary | ${rng.from} to ${rng.to}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const map: Record<string, { period: string; invCount: number; sub: number; tax: number; gross: number; retCount: number; ret: number }> = {};
    const order: string[] = [];
    for (const row of rows as GRow[]) {
      const p = String(row.Period || "");
      if (!map[p]) { map[p] = { period: p, invCount: 0, sub: 0, tax: 0, gross: 0, retCount: 0, ret: 0 }; order.push(p); }
      const cnt = parseInt(String(row.TxCount ?? 0), 10) || 0;
      const sub = parseFloat(String(row.SubTotalAmt ?? 0)) || 0;
      const tax = parseFloat(String(row.TaxAmt ?? 0)) || 0;
      const net = parseFloat(String(row.NetAmt ?? 0)) || 0;
      if (row.ModuleUID == 103) { map[p].invCount += cnt; map[p].sub += sub; map[p].tax += tax; map[p].gross += net; }
      if (row.ModuleUID == 106) { map[p].retCount += cnt; map[p].ret += net; }
    }
    const headers = ["Period", "Inv Count", "Subtotal", "Tax", "Sales", "Ret Count", "Returns", "Net Revenue"];
    const dataRows = order.map((p) => {
      const e = map[p];
      return [e.period, e.invCount, n(e.sub), n(e.tax), n(e.gross), e.retCount || "—", n(e.ret), n(e.gross - e.ret)];
    }) as (string | number)[][];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz });
  }

  async exportPurchaseSummary(orgUID: number, from: unknown, to: unknown, groupBy: unknown, type: ExportType): Promise<ExportResult> {
    const rng = await this.range(orgUID, from, to);
    const [rows, settings, org] = await Promise.all([
      this.repo.tradeSummary(orgUID, [105, 108], rng.from, rng.to, ReportsService.groupBy(groupBy)),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const fileName = `Purchase_Summary_${rng.from}_${rng.to}`;
    const previewName = `Purchase Summary | ${rng.from} to ${rng.to}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const map: Record<string, { period: string; purCount: number; sub: number; tax: number; gross: number; retCount: number; ret: number }> = {};
    const order: string[] = [];
    for (const row of rows as GRow[]) {
      const p = String(row.Period || "");
      if (!map[p]) { map[p] = { period: p, purCount: 0, sub: 0, tax: 0, gross: 0, retCount: 0, ret: 0 }; order.push(p); }
      const cnt = parseInt(String(row.TxCount ?? 0), 10) || 0;
      const sub = parseFloat(String(row.SubTotalAmt ?? 0)) || 0;
      const tax = parseFloat(String(row.TaxAmt ?? 0)) || 0;
      const net = parseFloat(String(row.NetAmt ?? 0)) || 0;
      if (row.ModuleUID == 105) { map[p].purCount += cnt; map[p].sub += sub; map[p].tax += tax; map[p].gross += net; }
      if (row.ModuleUID == 108) { map[p].retCount += cnt; map[p].ret += net; }
    }
    const headers = ["Period", "Pur Count", "Subtotal", "Tax", "Purchases", "Ret Count", "Returns", "Net Purchase"];
    const dataRows = order.map((p) => {
      const e = map[p];
      return [e.period, e.purCount, n(e.sub), n(e.tax), n(e.gross), e.retCount || "—", n(e.ret), n(e.gross - e.ret)];
    }) as (string | number)[][];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz });
  }

  async exportMonthlySummary(orgUID: number, year: unknown, type: ExportType): Promise<ExportResult> {
    const y = parseInt(String(year || new Date().getFullYear()), 10) || new Date().getFullYear();
    const [rows, settings, org] = await Promise.all([
      this.repo.monthlySummary(orgUID, `${y}-01-01`, `${y}-12-31`),
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    const tz = settings.Timezone || "UTC";
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const fileName = `Monthly_Summary_${y}`;
    const previewName = `Monthly Summary | ${y}`;
    const n = (v: unknown) => (parseFloat(String(v ?? 0)) || 0).toFixed(2);
    type GRow = Record<string, unknown>;
    const ledger = Array.from({ length: 12 }, (_, i) => ({ mo: i + 1, sales: 0, salesRet: 0, pur: 0, purRet: 0 }));
    for (const row of rows as GRow[]) {
      const mo = parseInt(String(row.Mo ?? 0), 10) - 1;
      const mid = parseInt(String(row.ModuleUID ?? 0), 10);
      const amt = parseFloat(String(row.NetAmt ?? 0)) || 0;
      if (mo >= 0 && mo < 12) {
        if (mid === 103) ledger[mo].sales    += amt;
        if (mid === 106) ledger[mo].salesRet += amt;
        if (mid === 105) ledger[mo].pur      += amt;
        if (mid === 108) ledger[mo].purRet   += amt;
      }
    }
    const headers = ["Month", "Sales", "Sales Returns", "Net Sales", "Purchases", "Pur Returns", "Net Purchases", "Balance"];
    const dataRows = ledger.map((e) => {
      const netSales = e.sales - e.salesRet;
      const netPur   = e.pur   - e.purRet;
      const balance  = netSales - netPur;
      return [MONTHS[e.mo - 1], n(e.sales), n(e.salesRet), n(netSales), n(e.pur), n(e.purRet), n(netPur), n(balance)];
    }) as (string | number)[][];
    return this.exporter.build({ type, fileName, sheetName: previewName, previewName, headers, rows: dataRows, org, timezone: tz });
  }
}
