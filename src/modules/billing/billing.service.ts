import { Injectable, Logger } from "@nestjs/common";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { PdfRendererService } from "../../libraries/pdf-renderer/pdf-renderer.service";
import { billingFy } from "../../core/utils/billing-fy";

export interface BillingInvoiceData {
  invoice_number: string;
  invoice_date?: string;
  financial_year?: string;
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
      const seller = await this._fetchSellerConfig();
      const html = this._buildHtml(data, seller);
      const pdfBuffer = await this.pdfRenderer.render(html, { paperSize: "A4" });
      return await this._uploadToR2(pdfBuffer, data);
    } catch (err) {
      this.logger.error(`generateAndUpload failed: ${(err as Error).message}`, (err as Error).stack);
      return null;
    }
  }

  /* ── HTML template ─────────────────────────────────────────────────────── */

  /**
   * @param d       Invoice data
   * @param seller  Seller config fetched from R2
   * @returns Full HTML string for the invoice
   */
  private _buildHtml(d: BillingInvoiceData, seller: SellerConfig): string {
    const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

    const invoiceNumber = esc(d.invoice_number ?? "");
    const invoiceDate = d.invoice_date ? this._formatDate(d.invoice_date) : this._formatDate(new Date().toISOString().slice(0, 10));
    const fy = esc(d.financial_year ?? "");

    const orgName = esc(d.org_name ?? "");
    const gstin = esc(d.gstin ?? "");
    const addr1 = esc(d.org_address1 ?? "");
    const addr2 = esc(d.org_address2 ?? "");
    const city = esc(d.org_city ?? "");
    const state = esc(d.org_state ?? "");
    const pincode = esc(d.org_pincode ?? "");
    const phone = esc(d.org_phone ?? "");
    const email = esc(d.org_email ?? "");

    const planName = esc(d.plan_name ?? "");
    const billingCycle = esc(d.billing_cycle ?? "");
    const renewalType = esc(d.renewal_type ?? "Renewal");

    const fmt = (v: number | string | undefined) => Number(v ?? 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const taxableAmt = fmt(d.taxable_amount);
    const taxRate = fmt(d.tax_rate);
    const taxAmt = fmt(d.tax_amount);
    const totalAmt = fmt(d.total_amount);

    const addressParts = [addr1, addr2, city, state, pincode].filter(Boolean);
    const addressHtml = addressParts.join("<br>");

    const sellerName = esc(seller.name ?? "");
    const sellerGstin = esc(seller.gstin ?? "");
    const sellerAddr = esc(seller.addr ?? "").replace(/\n/g, "<br>");
    const sellerPhone = esc(seller.phone ?? "");
    const sellerEmail = esc(seller.email ?? "");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
      font-family: Arial, Helvetica, sans-serif;
      font-size: 12px;
      color: #1a1a2e;
      background: #fff;
      padding: 32px 36px;
  }
  .inv-header {
      border-bottom: 3px solid #1a1a2e;
      padding-bottom: 16px;
      margin-bottom: 20px;
  }
  .inv-header table { width: 100%; }
  .inv-title {
      font-size: 26px;
      font-weight: bold;
      letter-spacing: 2px;
      color: #1a1a2e;
  }
  .inv-badge {
      display: inline-block;
      background: #1a1a2e;
      color: #fff;
      padding: 3px 10px;
      border-radius: 3px;
      font-size: 10px;
      letter-spacing: 1px;
      margin-top: 4px;
  }
  .inv-meta { text-align: right; line-height: 1.7; }
  .inv-meta .label { color: #666; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .inv-meta .value { font-weight: bold; font-size: 13px; }
  .inv-meta .fy { font-size: 10px; color: #888; }
  .parties { width: 100%; margin-bottom: 20px; }
  .parties td { width: 50%; vertical-align: top; }
  .party-box {
      background: #f7f8fc;
      border: 1px solid #e0e4ef;
      border-radius: 4px;
      padding: 12px 14px;
  }
  .party-box.right { margin-left: 8px; }
  .party-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #888;
      margin-bottom: 6px;
  }
  .party-name { font-size: 13px; font-weight: bold; margin-bottom: 4px; }
  .party-detail { font-size: 11px; color: #444; line-height: 1.6; }
  .party-gstin { font-size: 10px; color: #666; margin-top: 4px; }
  .inv-items { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  .inv-items thead tr { background: #1a1a2e; color: #fff; }
  .inv-items thead th {
      padding: 8px 10px;
      text-align: left;
      font-size: 11px;
      letter-spacing: 0.5px;
  }
  .inv-items thead th.right { text-align: right; }
  .inv-items tbody td {
      padding: 10px 10px;
      border-bottom: 1px solid #e8ebf4;
      font-size: 11px;
      vertical-align: top;
  }
  .inv-items tbody td.right { text-align: right; }
  .inv-items tbody tr:nth-child(even) td { background: #fafbfe; }
  .totals-wrap { width: 100%; }
  .totals-wrap td.spacer { width: 55%; }
  .totals-table { width: 45%; border-collapse: collapse; }
  .totals-table tr td { padding: 5px 8px; font-size: 11px; }
  .totals-table tr td.lbl { color: #555; }
  .totals-table tr td.amt { text-align: right; }
  .totals-table tr.total-row td {
      border-top: 2px solid #1a1a2e;
      padding-top: 8px;
      font-size: 13px;
      font-weight: bold;
  }
  .totals-table tr.sub-row td { border-bottom: 1px solid #eee; }
  .inv-footer {
      margin-top: 28px;
      border-top: 1px solid #dde0ec;
      padding-top: 14px;
      font-size: 10px;
      color: #888;
      text-align: center;
      line-height: 1.7;
  }
  .inv-footer strong { color: #444; }
  .paid-stamp {
      display: inline-block;
      border: 3px solid #16a34a;
      color: #16a34a;
      padding: 4px 16px;
      font-size: 16px;
      font-weight: bold;
      letter-spacing: 3px;
      border-radius: 4px;
      transform: rotate(-8deg);
      float: right;
      margin-top: -36px;
      margin-right: 8px;
  }
</style>
</head>
<body>

<div class="inv-header">
  <table>
    <tr>
      <td>
        <div class="inv-title">INVOICE</div>
        <div class="inv-badge">SUBSCRIPTION</div>
      </td>
      <td class="inv-meta">
        <div class="label">Invoice Number</div>
        <div class="value">${invoiceNumber}</div>
        <div class="fy">FY ${fy}</div>
        <br>
        <div class="label">Invoice Date</div>
        <div class="value">${invoiceDate}</div>
      </td>
    </tr>
  </table>
</div>

<table class="parties">
  <tr>
    <td>
      <div class="party-box">
        <div class="party-label">Billed By</div>
        <div class="party-name">${sellerName}</div>
        <div class="party-detail">${sellerAddr}</div>
        <div class="party-detail">${sellerPhone} &nbsp;|&nbsp; ${sellerEmail}</div>
        <div class="party-gstin">GSTIN: ${sellerGstin}</div>
      </div>
    </td>
    <td>
      <div class="party-box right">
        <div class="party-label">Billed To</div>
        <div class="party-name">${orgName}</div>
        <div class="party-detail">${addressHtml}</div>
        <div class="party-detail">${phone}</div>
        <div class="party-detail">${email}</div>
        <div class="party-gstin">GSTIN: ${gstin}</div>
      </div>
    </td>
  </tr>
</table>

<table class="inv-items">
  <thead>
    <tr>
      <th style="width:5%">#</th>
      <th style="width:40%">Description</th>
      <th style="width:20%">Type</th>
      <th class="right" style="width:17%">Base Amount</th>
      <th class="right" style="width:18%">Total</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>1</td>
      <td>
        <strong>${planName}</strong>
        <br><span style="color:#666;font-size:10px;">${billingCycle} Subscription</span>
      </td>
      <td>${renewalType}</td>
      <td class="right">&#8377; ${taxableAmt}</td>
      <td class="right">&#8377; ${totalAmt}</td>
    </tr>
  </tbody>
</table>

<table class="totals-wrap">
  <tr>
    <td class="spacer">
      <div class="paid-stamp">PAID</div>
    </td>
    <td>
      <table class="totals-table">
        <tr class="sub-row">
          <td class="lbl">Taxable Amount</td>
          <td class="amt">&#8377; ${taxableAmt}</td>
        </tr>
        <tr class="sub-row">
          <td class="lbl">GST @ ${taxRate}%</td>
          <td class="amt">&#8377; ${taxAmt}</td>
        </tr>
        <tr class="total-row">
          <td class="lbl">Total</td>
          <td class="amt">&#8377; ${totalAmt}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>

<div class="inv-footer">
  <strong>This is a computer-generated invoice and does not require a signature.</strong><br>
  For queries, contact ${sellerEmail} &nbsp;|&nbsp; ${sellerPhone}
</div>

</body>
</html>`;
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

  /* ── Seller config ─────────────────────────────────────────────────────── */

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
