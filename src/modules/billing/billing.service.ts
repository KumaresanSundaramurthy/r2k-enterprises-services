import { Injectable, Logger } from "@nestjs/common";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { PdfRendererService } from "../../libraries/pdf-renderer/pdf-renderer.service";
import { billingFy } from "../../core/utils/billing-fy";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";

export interface BillingInvoiceData {
  invoice_number: string;
  invoice_date?: string;
  due_date?: string;
  financial_year?: string;
  place_of_supply?: string;
  org_name?: string;
  gstin?: string;
  org_address1?: string;
  org_address2?: string;
  org_city?: string;
  org_state?: string;
  org_pincode?: string;
  org_phone?: string;
  org_email?: string;
  plan_name?: string;
  billing_cycle?: string;
  renewal_type?: string;
  taxable_amount?: number | string;
  tax_rate?: number | string;
  tax_amount?: number | string;
  total_amount?: number | string;
  order_uid?: number;
  org_uid?: number;
}

interface SellerConfig {
  name?: string;
  gstin?: string;
  addr?: string;
  phone?: string;
  email?: string;
  signature?: string;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly pdfRenderer: PdfRendererService,
    private readonly fileUpload: FileUploadService
  ) {}

  /**
   * Generate a subscription invoice PDF and upload it to Cloudflare R2.
   * @param data  Invoice payload (see BillingInvoiceData)
   * @returns CDN URL of the uploaded PDF, or null on failure
   */
  async generateAndUpload(data: BillingInvoiceData): Promise<string | null> {
    try {
      const [seller, template] = await Promise.all([
        this._fetchSellerConfig(),
        this._fetchInvoiceTemplate(),
      ]);
      const html = this._buildHtml(data, seller, template);
      const pdfBuffer = await this.pdfRenderer.render(html, { paperSize: "A4" });
      return await this._uploadToR2(pdfBuffer, data);
    } catch (err) {
      this.logger.error(`generateAndUpload failed: ${(err as Error).message}`, (err as Error).stack);
      return null;
    }
  }

  /* ── HTML template ─────────────────────────────────────────────────────── */

  /**
   * Fetches the invoice_template.html from Cloudflare R2 and fills all
   * {{PLACEHOLDER}} tokens with real invoice data.
   * @param d        Invoice data
   * @param seller   Seller config fetched from R2
   * @param template Raw HTML from R2 (invoice_template.html)
   * @returns Filled HTML string ready for PDF rendering
   */
  private _buildHtml(d: BillingInvoiceData, seller: SellerConfig, template: string): string {
    const esc = (v: string) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    const invoiceDate   = this._formatDate(d.invoice_date ?? new Date().toISOString().slice(0, 10));
    const dueDate       = d.due_date ? this._formatDate(d.due_date) : invoiceDate;
    const fmtNum        = (v: number | string | undefined) =>
      Number(v ?? 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const taxRateNum    = Number(d.tax_rate ?? 18);
    const taxRateFmt    = taxRateNum % 1 === 0 ? String(taxRateNum) : taxRateNum.toFixed(1);
    const totalNum      = Number(d.total_amount ?? 0);

    const addr1 = esc(d.org_address1 ?? "");
    const addr2 = esc(d.org_address2 ?? "");
    const city  = esc(d.org_city ?? "");
    const state = esc(d.org_state ?? "");
    const pin   = esc(d.org_pincode ?? "");
    const billingAddr = [addr1, addr2, [city, state].filter(Boolean).join(", "), pin].filter(Boolean).join("<br>");

    const sellerName = esc(seller.name ?? "");

    const tokens: Record<string, string> = {
      SELLER_NAME:       sellerName,
      SELLER_NAME_UPPER: sellerName.toUpperCase(),
      SELLER_GSTIN:      esc(seller.gstin ?? ""),
      SELLER_ADDR:       esc(seller.addr ?? "").replace(/\n/g, "<br>"),
      SELLER_PHONE:      esc(seller.phone ?? ""),
      SELLER_EMAIL:      esc(seller.email ?? ""),
      SELLER_SIGNATURE:  seller.signature
        ? `<img src="${esc(seller.signature)}" style="max-height:48px;max-width:160px;display:block;">`
        : "",
      INVOICE_NUMBER:    esc(d.invoice_number ?? ""),
      INVOICE_DATE:      invoiceDate,
      DUE_DATE:          dueDate,
      FINANCIAL_YEAR:    esc(d.financial_year ?? ""),
      PLACE_OF_SUPPLY:   esc(d.place_of_supply ?? (d.org_state ?? "")),
      ORG_NAME:          esc(d.org_name ?? ""),
      ORG_GSTIN:         esc(d.gstin ?? ""),
      ORG_PHONE:         esc(d.org_phone ?? ""),
      ORG_EMAIL:         esc(d.org_email ?? ""),
      BILLING_ADDR:      billingAddr,
      PLAN_NAME:         esc(d.plan_name ?? ""),
      BILLING_CYCLE:     esc(d.billing_cycle ?? ""),
      RENEWAL_TYPE:      esc(d.renewal_type ?? "New"),
      HSN_CODE:          "998314",
      TAXABLE_AMOUNT:    fmtNum(d.taxable_amount),
      TAX_RATE:          taxRateFmt,
      TAX_AMOUNT:        fmtNum(d.tax_amount),
      TOTAL_AMOUNT:      fmtNum(d.total_amount),
      AMOUNT_IN_WORDS:   this._amountInWords(totalNum),
    };

    return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => tokens[key] ?? "");
  }

  /** Convert a number to Indian rupees in words. */
  private _amountInWords(amount: number): string {
    const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
                  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
                  "Seventeen", "Eighteen", "Nineteen"];
    const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

    const toWords = (n: number): string => {
      if (n === 0) return "";
      if (n < 20) return ones[n] + " ";
      if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "") + " ";
      if (n < 1000) return ones[Math.floor(n / 100)] + " Hundred " + toWords(n % 100);
      if (n < 100000) return toWords(Math.floor(n / 1000)) + "Thousand " + toWords(n % 1000);
      if (n < 10000000) return toWords(Math.floor(n / 100000)) + "Lakh " + toWords(n % 100000);
      return toWords(Math.floor(n / 10000000)) + "Crore " + toWords(n % 10000000);
    };

    const rupees = Math.floor(amount);
    const paise  = Math.round((amount - rupees) * 100);
    let result   = "INR " + (toWords(rupees).trim() || "Zero") + " Rupees";
    if (paise > 0) result += " And " + toWords(paise).trim() + " Paise";
    result += " Only";
    return result;
  }

  /* ── Invoice regeneration ───────────────────────────────────────────────── */

  /**
   * Re-generates an invoice PDF using the latest template and re-uploads to R2.
   * All source data is read from SubscriptionInvoicesTbl (snapshot stored at invoice creation).
   * @param invoiceUID  SubscriptionInvoicesTbl.InvoiceUID
   * @param orgUID      Org scope guard — must match the order's OrgUID
   * @returns New R2 URL on success, null on failure
   */
  async regenerateInvoicePdf(invoiceUID: number, orgUID: number): Promise<string | null> {
    type Row = Record<string, unknown>;
    const row = (await erpKnexRead("Billing.SubscriptionInvoicesTbl as SI")
      .join("Billing.SubscriptionOrdersTbl as SO", "SO.OrderUID", "SI.OrderUID")
      .leftJoin("Billing.SectorPlanTbl as SPT", "SPT.SectorPlanUID", "SO.SectorPlanUID")
      .leftJoin("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select(
        "SI.InvoiceUID", "SI.InvoiceNumber", "SI.InvoiceDate", "SI.FinancialYear",
        "SI.OrgName", "SI.GSTIN", "SI.OrgAddress1", "SI.OrgAddress2",
        "SI.OrgCity", "SI.OrgState", "SI.OrgPincode", "SI.OrgPhone", "SI.OrgEmail",
        "SI.TaxableAmount", "SI.TaxRate", "SI.TaxAmount", "SI.TotalAmount",
        "SO.OrderUID", "SO.RenewalType",
        erpKnexRead.raw("COALESCE(SP.BillingCycle, '') AS BillingCycle"),
        erpKnexRead.raw("COALESCE(SP.PlanName, '') AS PlanName"),
      )
      .where({ "SI.InvoiceUID": invoiceUID, "SO.OrgUID": orgUID })
      .first()) as Row | undefined;

    if (!row) return null;

    const str  = (k: string) => String(row[k] ?? "");
    const num  = (k: string) => Number(row[k] ?? 0);

    const pdfUrl = await this.generateAndUpload({
      invoice_number:  str("InvoiceNumber"),
      invoice_date:    str("InvoiceDate").slice(0, 10),
      financial_year:  str("FinancialYear"),
      org_name:        str("OrgName"),
      gstin:           str("GSTIN"),
      org_address1:    str("OrgAddress1"),
      org_address2:    str("OrgAddress2"),
      org_city:        str("OrgCity"),
      org_state:       str("OrgState"),
      org_pincode:     str("OrgPincode"),
      org_phone:       str("OrgPhone"),
      org_email:       str("OrgEmail"),
      plan_name:       str("PlanName"),
      billing_cycle:   str("BillingCycle"),
      renewal_type:    str("RenewalType") || "New",
      taxable_amount:  num("TaxableAmount"),
      tax_rate:        num("TaxRate"),
      tax_amount:      num("TaxAmount"),
      total_amount:    num("TotalAmount"),
      order_uid:       num("OrderUID"),
      org_uid:         orgUID,
    });

    if (pdfUrl) {
      await erpKnexWrite("Billing.SubscriptionInvoicesTbl")
        .where({ InvoiceUID: invoiceUID })
        .update({ PDFPath: pdfUrl });
    }
    return pdfUrl;
  }

  /* ── Invoice lookup (for browser download) ──────────────────────────────── */

  /**
   * Returns InvoiceNumber + PDFPath for a given invoice, scoped to the org.
   * @param invoiceUID  SubscriptionInvoicesTbl.InvoiceUID
   * @param orgUID      Must match the order's OrgUID to prevent cross-org access
   */
  async getInvoicePdfPath(invoiceUID: number, orgUID: number): Promise<{ InvoiceNumber: string; PDFPath: string } | null> {
    type Row = { InvoiceNumber: string; PDFPath: string };
    const row = (await erpKnexRead("Billing.SubscriptionInvoicesTbl as SI")
      .join("Billing.SubscriptionOrdersTbl as SO", "SO.OrderUID", "SI.OrderUID")
      .select("SI.InvoiceNumber", "SI.PDFPath")
      .where({ "SI.InvoiceUID": invoiceUID, "SO.OrgUID": orgUID })
      .first()) as Row | undefined;
    return row ?? null;
  }

  /* ── Upload to Cloudflare R2 ─────────────────────────────────────────────── */

  /**
   * @param pdfBuffer  PDF bytes
   * @param d          Invoice data (for path construction)
   * @returns CDN URL of the uploaded PDF
   */
  private async _uploadToR2(pdfBuffer: Buffer, d: BillingInvoiceData): Promise<string> {
    const fy = (d.financial_year ?? this._billingFy()).replace(/[^0-9-]/g, "");
    const orgUID = d.org_uid ?? 0;
    const invNum = (d.invoice_number ?? "invoice").replace(/[^A-Za-z0-9-]/g, "");
    const r2Path = `Billing/Invoices/${fy}/${orgUID}/${invNum}.pdf`;
    const result = await this.fileUpload.upload(r2Path, pdfBuffer, "application/pdf");
    return result.FullPath;
  }

  /* ── R2 assets ─────────────────────────────────────────────────────────── */

  /**
   * Fetch seller config JSON from Cloudflare R2 CDN.
   * Returns empty object on any failure — invoice generation must not break.
   * @returns Seller config fields
   */
  private async _fetchSellerConfig(): Promise<SellerConfig> {
    const cdn = process.env.CFLARE_R2_CDN;
    if (!cdn) return {};
    try {
      const url = `${cdn.replace(/\/+$/, "")}/Global/billing_seller.json`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return {};
      return (await res.json()) as SellerConfig;
    } catch {
      return {};
    }
  }

  /**
   * Fetch invoice_template.html from Cloudflare R2 CDN.
   * Falls back to an empty string on failure — _buildHtml handles it gracefully.
   * @returns Raw HTML template string with {{PLACEHOLDER}} tokens
   */
  private async _fetchInvoiceTemplate(): Promise<string> {
    try {
      const url = "https://pub-bb40942a33344637936ade1f3800ff8b.r2.dev/Global/invoice_template.html";
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return "";
      return await res.text();
    } catch {
      return "";
    }
  }

  /* ── Helpers ────────────────────────────────────────────────────────────── */

  /**
   * @param dateStr  YYYY-MM-DD
   * @returns Formatted date like "17 Nov 2026"
   */
  private _formatDate(dateStr: string): string {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const d = new Date(dateStr + "T00:00:00Z");
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  private _billingFy(): string { return billingFy("full"); }
}
