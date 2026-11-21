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

  // getGstr3bData — outward and ITC totals for the month
  async gstr3b(orgUID: number, month: unknown, year: unknown) {
    const p = await this.gstPeriod(orgUID, month, year);
    return { Status: "Success", ...(await this.repo.gstr3b(orgUID, p.month, p.year)) };
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
}
