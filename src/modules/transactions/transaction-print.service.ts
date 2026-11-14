import { Injectable } from "@nestjs/common";
import { escapeHtml, parseDateTime, phpDate, phpRound, resolveCdnUrl, smartDecimal } from "../../common/utils/php-compat";
import { applyTokens, buildQrHtml, numberToWords } from "../../common/utils/print-tokens";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { PdfRendererService } from "../../libraries/pdf-renderer/pdf-renderer.service";
import { TransactionLookupsRepository } from "./transaction-lookups.repository";
import { TransactionsRepository } from "./transactions.repository";

type Row = Record<string, unknown>;

const NON_EDITABLE = ["Converted", "Cancelled", "Rejected"];
const SYSTEM_FONTS = ["Arial", "Helvetica", "Verdana", "Tahoma", "Trebuchet MS", "Times New Roman", "Georgia", "Palatino Linotype", "Calibri"];
const DUE_DATE_LABELS: Record<number, string> = {
  103: "Due Date",
  101: "Due Date",
  108: "Due Date",
  106: "",
  113: "Valid Until",
  112: "Delivery By",
  105: "Payment By",
  104: "Payment By",
  102: "Expected Delivery Date",
};
const SIGNATURE_SPACE = '<div style="min-height:65px;"></div>';
const WATERMARK = ".r2k-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:72px;font-weight:800;letter-spacing:4px;color:rgba(0,0,0,0.045);white-space:nowrap;pointer-events:none;z-index:9999;}";

const e = (value: unknown) => escapeHtml(String(value ?? ""));
const s = (value: unknown) => String(value ?? "");
const n = (value: unknown) => Number(value ?? 0) || 0;
// PHP number_format($v, $dec, '.', '') — smartDecimal($v, 2, true)
const fixed = (value: number, decimals = 2) => phpRound(value, decimals).toFixed(decimals);
// PHP number_format($v, $dec) — with thousands separators
const grouped = (value: number, decimals: number) => phpRound(value, decimals).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const nl2br = (html: string) => html.replace(/\r\n|\n|\r/g, (m) => `<br />${m}`);
const joinAddress = (...parts: unknown[]) => parts.map(s).filter(Boolean).join(", ");

interface PrintContext {
  currency: string;
  printDateFormat: string;
  timezone: string;
}

/**
 * Transaction detail and A4 print (CI3 Transactions::getTransactionDetail and Transactions_model::_renderA4Html):
 * the module's print template with its {{TOKENS}}, item / HSN loops and totals filled in.
 */
@Injectable()
export class TransactionPrintService {
  constructor(
    private readonly reads: TransactionsRepository,
    private readonly lookups: TransactionLookupsRepository,
    private readonly orgInfo: OrgInfoCacheService,
    private readonly orgSettings: OrgSettingsService,
    private readonly pdfRenderer: PdfRendererService
  ) {}

  /**
   * getTransactionDetail — PrintType a4: the header and the print HTML; thermal: header, lines, org info and the
   * thermal config; view: header, lines, payments, files, org info and whether it can still be edited.
   */
  async detail(orgUID: number, transUID: number, moduleUID: number, printType: string) {
    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    if (moduleUID <= 0) throw new CiValidationError("ModuleUID is required.");
    const header = await this.reads.find(orgUID, transUID, moduleUID);
    if (!header) throw new CiValidationError("Transaction not found.");

    if (printType === "a4") {
      const [items, org, theme, bank] = await Promise.all([
        this.reads.items(orgUID, transUID),
        this.orgInfo.get(orgUID),
        this.lookups.printTheme(orgUID, moduleUID),
        this.lookups.printBankAccount(orgUID),
      ]);
      let html: string;
      try {
        html = await this.renderA4(orgUID, moduleUID, header, items, org ?? {}, theme ?? {}, bank);
      } catch (err) {
        html = `<div style="padding:20px;color:#c00;">Preview error: ${e((err as Error).message)}</div>`;
      }
      return { Header: header, PrintHtml: html };
    }
    if (printType === "thermal") {
      const [items, org, thermal] = await Promise.all([this.reads.items(orgUID, transUID), this.orgInfo.get(orgUID), this.lookups.thermalConfig(orgUID, moduleUID)]);
      return { Header: header, Items: items, OrgInfo: org, ThermalConfig: thermal };
    }
    if (printType === "view") {
      const [items, payments, files, org] = await Promise.all([this.reads.items(orgUID, transUID), this.reads.payments(orgUID, transUID), this.reads.attachments(orgUID, transUID), this.orgInfo.get(orgUID)]);
      return {
        Header: { ...header, AmountInWords: numberToWords(n(header.NetAmount)) },
        Items: items,
        Payments: payments,
        PaidTotal: payments.reduce((total, payment) => total + n(payment.Amount), 0),
        Attachments: files,
        OrgInfo: org,
        Permissions: { CanEdit: !NON_EDITABLE.includes(s(header.DocStatus)) },
      };
    }
    return { Header: header };
  }

  /**
   * generateTransactionPdfBytes — the A4 print of a document as a PDF (null when the document is not found).
   * Chrome renders the template as the browser print does, so Dompdf's workarounds (flex / position stripping,
   * QR compositing, image inlining, canvas watermark) are not needed; the copy label, body reset and @page
   * size / margins are applied as in CI3.
   */
  async pdf(orgUID: number, transUID: number, moduleUID: number, paperSize: string): Promise<{ header: Row; bytes: Buffer } | null> {
    const header = await this.reads.find(orgUID, transUID, moduleUID);
    if (!header) return null;
    const [items, org, theme, bank] = await Promise.all([
      this.reads.items(orgUID, transUID),
      this.orgInfo.get(orgUID),
      this.lookups.printTheme(orgUID, moduleUID),
      this.lookups.printBankAccount(orgUID),
    ]);
    const size = PdfRendererService.paperFormat(paperSize);
    const html = (await this.renderA4(orgUID, moduleUID, header, items, org ?? {}, theme ?? {}, bank))
      .replace(/__COPY_LABEL__/g, "ORIGINAL FOR RECIPIENT")
      .replace("</head>", "<style>body{padding:0!important;margin:0!important;}.print-content{margin:0!important;}#trans-type-header td{border-left:none!important;border-right:none!important;}</style></head>")
      .replace(/@page\s*\{[^}]*\}/g, `@page{size:${size};margin:10mm 5mm;}`);
    const bytes = await this.pdfRenderer.render(html, { paperSize: size, margin: { top: "10mm", bottom: "10mm", left: "5mm", right: "5mm" } });
    return { header, bytes };
  }

  // _renderA4Html — the organisation's template for the module, or the built-in layout without one
  private async renderA4(orgUID: number, moduleUID: number, h: Row, items: Row[], org: Row, theme: Row, bank: Row | null): Promise<string> {
    const [settings, txSettings] = await Promise.all([this.orgSettings.get(orgUID), this.lookups.settings(orgUID)]);
    const ctx: PrintContext = { currency: `${txSettings.currency} `, printDateFormat: txSettings.printDateFormat, timezone: settings.Timezone };
    const template = s(theme.TemplateHtmlContent);
    if (!template) return TransactionPrintService.genericA4(h, items, org, ctx);

    const cur = ctx.currency;
    const showDate = (value: unknown) => {
      const date = parseDateTime(s(value));
      return date ? phpDate(ctx.printDateFormat, date, "UTC") : s(value) || "—";
    };
    const addressHtml = (l1: unknown, l2: unknown, city: unknown, state: unknown, pin: unknown) => {
      let cityState = [e(city), e(state)].filter(Boolean).join(", ");
      if (s(pin)) cityState += (cityState ? " - " : "") + e(pin);
      return [e(l1), e(l2), cityState].filter(Boolean).join("<br>");
    };
    const plainAddressHtml = (...parts: unknown[]) => parts.map(s).filter(Boolean).map(e).join("<br>");

    // Items table and totals
    const itemRows = items
      .map((item, i) => {
        const tax = phpRound(n(item.CgstAmount) + n(item.SgstAmount) + n(item.IgstAmount), 2);
        return (
          `<tr><td style="text-align:center">${i + 1}</td><td>${e(item.ProductName)}</td><td style="text-align:center">${e(item.HSNCode ?? "-")}</td>` +
          `<td style="text-align:right">${fixed(n(item.UnitPrice))}</td><td style="text-align:center">${smartDecimal(item.Quantity ?? 0)} ${e(item.PrimaryUnitName)}</td>` +
          `<td style="text-align:right">${fixed(phpRound(n(item.UnitPrice) * n(item.Quantity), 2))}</td>` +
          `<td style="text-align:right">${tax ? `${fixed(tax)} (${grouped(n(item.TaxPercentage), 0)}%)` : ""}</td><td style="text-align:right">${fixed(n(item.NetAmount))}</td></tr>`
        );
      })
      .join("");
    const th = (label: string, style = "") => `<th style="border:1px solid #ddd;padding:5px;${style}">${label}</th>`;
    const itemsTable =
      '<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px;"><thead><tr style="background:#f5f5f5;">' +
      th("#", "text-align:center;width:28px") +
      th("Item") +
      th("HSN/SAC") +
      th("Rate", "text-align:right;") +
      th("Qty", "text-align:center;") +
      th("Taxable Value", "text-align:right;") +
      th("Tax Amt", "text-align:right;") +
      th("Amount", "text-align:right;") +
      `</tr></thead><tbody>${itemRows}</tbody></table>`;
    const td = "border:1px solid #ddd;padding:5px;text-align:right;";
    const totals =
      '<table style="width:100%;border-collapse:collapse;font-size:8.5pt;margin-bottom:8px;">' +
      `<tr><td style="${td}font-weight:600;">Sub Total</td><td style="${td}width:120px;">${cur}${fixed(n(h.SubTotal))}</td></tr>` +
      (n(h.DiscountAmount) > 0 ? `<tr><td style="${td}color:#c00;">Discount</td><td style="${td}color:#c00;">- ${cur}${fixed(n(h.DiscountAmount))}</td></tr>` : "") +
      (n(h.TaxAmount) > 0 ? `<tr><td style="${td}">Tax</td><td style="${td}">${cur}${fixed(n(h.TaxAmount))}</td></tr>` : "") +
      `<tr><td style="${td}font-weight:700;">Net Amount</td><td style="${td}font-weight:700;">${cur}${fixed(n(h.NetAmount))}</td></tr></table>`;

    // Addresses: the dispatch-from address (DispatchFrom) replaces the customer's shipping address
    const billAddress = joinAddress(h.BillLine1, h.BillLine2, h.BillCity, h.BillState, h.BillPincode);
    let shipAddressHtml = addressHtml(h.ShipLine1, h.ShipLine2, h.ShipCity, h.ShipState, h.ShipPincode);
    const customerAddressHtml =
      plainAddressHtml(h.BillLine1, h.BillLine2, h.BillCity, h.BillState, h.BillPincode) || plainAddressHtml(h.ShipLine1, h.ShipLine2, h.ShipCity, h.ShipState, h.ShipPincode);
    if (n(h.DispatchFrom) > 0) {
      const dispatch = await this.lookups.addressByUID(orgUID, n(h.DispatchFrom));
      if (dispatch && joinAddress(dispatch.Line1, dispatch.Line2, dispatch.CityText, dispatch.StateText, dispatch.Pincode)) {
        shipAddressHtml = addressHtml(dispatch.Line1, dispatch.Line2, dispatch.CityText, dispatch.StateText, dispatch.Pincode);
      }
    }

    const orgName = s(org.BrandName ?? org.Name);
    const orgCityState = [org.CityText, org.StateText].map(s).filter(Boolean).join(", ");
    const orgInfoLines = [e(org.Line1), e(org.Line2), [e(orgCityState), e(org.Pincode)].filter(Boolean).join(" - "), org.GSTIN ? `<b>GSTIN:</b> ${e(org.GSTIN)}` : ""].filter(Boolean).join("<br>");
    const notesPart = h.Notes ? `<p style="font-size:8pt;margin-top:4px;"><strong>Notes:</strong> ${nl2br(e(h.Notes))}</p>` : "";
    const termsPart = h.TermsConditions ? `<p style="font-size:8pt;margin-top:4px;"><strong>Terms:</strong> ${nl2br(e(h.TermsConditions))}</p>` : "";

    // HSN totals from the lines (match the HSN summary rows)
    const hsnTaxable = items.reduce((sum, item) => sum + phpRound(n(item.UnitPrice) * n(item.Quantity), 2), 0);
    const hsnCgst = items.reduce((sum, item) => sum + n(item.CgstAmount), 0);
    const hsnSgst = items.reduce((sum, item) => sum + n(item.SgstAmount), 0);
    const hsnIgst = items.reduce((sum, item) => sum + n(item.IgstAmount), 0);

    let partyBalance = "";
    if (Number(theme.ShowPartyBalance)) {
      const balance = await this.lookups.partyBalance(orgUID, s(h.PartyType), n(h.PartyUID));
      if (balance) partyBalance = `${cur}${smartDecimal(balance.balance)} ${balance.type === "Debit" ? "Dr" : "Cr"}`;
    }
    const createdOn = parseDateTime(s(h.CreatedOn));

    const tokens: Record<string, string> = {
      "{{PRIMARY_COLOR}}": s(theme.PrimaryColor ?? "#1a3c6e"),
      "{{ACCENT_COLOR}}": s(theme.AccentColor ?? "#f59e0b"),
      "{{FONT_FAMILY}}": s(theme.FontFamily ?? "Arial"),
      "{{FONT_SIZE_PX}}": `${theme.FontSizePx ?? 11}px`,
      "{{FONT_SIZE}}": `${theme.FontSizePx ?? 11}px`,
      "{{ORG_LOGO}}": org.Logo ? `<img src="${e(org.Logo)}" style="max-width:100px;max-height:100px;" alt="Logo">` : "",
      "{{ORG_NAME}}": e(orgName),
      "{{ORG_GSTIN}}": e(org.GSTIN),
      "{{ORG_ADDRESS_1}}": e(org.Line1),
      "{{ORG_ADDRESS_2}}": e(org.Line2),
      "{{ORG_CITY_STATE}}": e(orgCityState),
      "{{ORG_PINCODE}}": e(org.Pincode),
      "{{ORG_PHONE}}": e(org.MobileNumber),
      "{{ORG_EMAIL}}": e(org.EmailAddress),
      "{{ORG_BANK_NAME}}": e(org.BankName),
      "{{ORG_ACCOUNT_NO}}": e(org.AccountNo),
      "{{ORG_IFSC}}": e(org.IFSC),
      "{{ORG_BRANCH}}": e(org.Branch),
      "{{ORG_UPI_ID}}": e(org.UpiId),
      "{{ORG_INFO_LINES}}": orgInfoLines,
      "{{PLACE_OF_SUPPLY}}": e(h.PlaceOfSupplyCode ? `${h.PlaceOfSupplyCode} - ${s(h.PlaceOfSupplyName)}` : (h.PlaceOfSupplyName ?? org.StateText ?? "")),
      "{{BANK_DETAILS_LINES}}": [e(org.BankName), org.AccountNo ? `A/C: ${e(org.AccountNo)}` : "", org.IFSC ? `IFSC: ${e(org.IFSC)}` : ""].filter(Boolean).join("<br>"),
      "{{CURRENCY}}": cur,
      "{{CUSTOMER_NAME}}": e(h.PartyName ?? "—"),
      "{{CUSTOMER_PHONE}}": e(h.PartyMobile),
      "{{CUSTOMER_GSTIN}}": e(h.PartyGSTIN),
      "{{BILLING_ADDRESS}}": e(billAddress),
      "{{SHIPPING_ADDRESS}}": shipAddressHtml,
      "{{CUSTOMER_ADDRESS}}": customerAddressHtml,
      "{{PARTY_GSTIN}}": e(h.PartyGSTIN),
      "{{PARTY_PHONE}}": e(h.PartyMobile),
      "{{CUSTOMER_PHONE_LINE}}": h.PartyMobile ? `Ph: ${e(h.PartyMobile)}` : "",
      "{{PARTY_GSTIN_LINE}}": h.PartyGSTIN ? `GSTIN: ${e(h.PartyGSTIN)}` : "",
      "{{DOC_TYPE}}": e(h.TransType ?? "Document"),
      "{{DOC_NUMBER}}": e(h.UniqueNumber ?? "—"),
      "{{DOC_DATE}}": showDate(h.TransDate),
      "{{DOC_TIME}}": createdOn && Number(theme.ShowTime ?? 0) ? phpDate("h:i A", createdOn, ctx.timezone) : "",
      "{{PARTY_CLOSING_BALANCE}}": partyBalance,
      "{{PARTYBAL_SHOW}}": partyBalance ? "1" : "",
      "{{DUE_DATE}}": showDate(h.ValidityDate),
      "{{SHOW_DUE_DATE}}": [101, 102, 103, 104, 113].includes(moduleUID) ? "block" : "none",
      "{{DUE_DATE_LABEL}}": DUE_DATE_LABELS[moduleUID] ?? "Due Date",
      "{{REFERENCE}}": e(h.Reference),
      "{{SUPPLIER_INVOICE_NO}}": e(h.SupplierInvoiceNo),
      "{{ITEMS_TABLE}}": itemsTable,
      "{{ITEMS_TABLE_ROWS}}": itemRows,
      "{{TOTALS_SECTION}}": totals,
      "{{TOTALS_BLOCK}}": totals,
      "{{NOTES_TERMS}}": notesPart + termsPart,
      "{{FOOTER_TEXT}}": e(theme.FooterText ?? "Thank you for your business!"),
      "{{TRANS_NOTES}}": nl2br(e(h.Notes ?? "Thank you for your business!")),
      "{{TERMS_CONDITIONS}}": nl2br(e(h.TermsConditions)),
      "{{HSN_TAX_TABLE}}": "",
      "{{TOTAL_ITEMS_COUNT}}": s(h.TotalItems ?? items.length),
      "{{TOTAL_QTY}}": smartDecimal(n(h.TotalQuantity)),
      "{{TOTAL_TAXABLE_AMOUNT}}": fixed(n(h.SubTotal)),
      "{{TOTAL_CGST}}": fixed(n(h.CgstAmount)),
      "{{TOTAL_SGST}}": fixed(n(h.SgstAmount)),
      "{{TOTAL_IGST}}": fixed(n(h.IgstAmount)),
      "{{TOTAL_TAX}}": fixed(n(h.TaxAmount)),
      "{{TOTAL_DISCOUNT}}": fixed(n(h.DiscountAmount)),
      "{{NET_AMOUNT}}": fixed(n(h.NetAmount)),
      "{{AMOUNT_IN_WORDS}}": numberToWords(n(h.NetAmount)),
      "{{UPI_QR_CODE}}": e(org.UpiId),
      "{{BANK_NAME}}": bank ? e(bank.BankName) : "",
      "{{BANK_ACCOUNT_NAME}}": bank ? e(bank.AccountName) : "",
      "{{BANK_ACCOUNT_NO}}": bank ? e(bank.AccountNumber) : "",
      "{{BANK_IFSC}}": bank ? e(bank.IFSC) : "",
      "{{BANK_BRANCH}}": bank ? e(bank.BranchName) : "",
      "{{BANK_UPI_ID}}": bank ? e(bank.UPIId) : "",
      "{{BANK_QR_HTML}}": buildQrHtml(s(bank?.UPIId), n(h.NetAmount), orgName, s(org.Logo)),
      "{{SIGNATURE_SPACE}}": await this.signatureHtml(n(h.SignatureUID)),
      "{{COPY_LABEL}}": "__COPY_LABEL__",
      "{{HSN_TOTAL_TAXABLE}}": fixed(hsnTaxable),
      "{{HSN_TOTAL_CGST}}": fixed(hsnCgst),
      "{{HSN_TOTAL_SGST}}": fixed(hsnSgst),
      "{{HSN_TOTAL_IGST}}": fixed(hsnIgst),
      "{{HSN_TOTAL_TAX}}": fixed(phpRound(hsnCgst + hsnSgst + hsnIgst, 2)),
    };

    let html = TransactionPrintService.itemLoops(template, items, cur);
    html = TransactionPrintService.hsnSummary(html, items);
    html = applyTokens(html, tokens);

    const font = s(theme.FontFamily ?? "Arial");
    let style =
      `<style>@page{size:A4;margin:0;}@media print{body{background:#fff;}}body{padding:0 5mm;box-sizing:border-box;font-size:${parseInt(s(theme.FontSizePx ?? 11), 10) || 0}px !important;}` +
      ".invoice{width:100%!important;max-width:100%!important;box-sizing:border-box!important;margin:10px 0!important;}" +
      `body,body *{font-family:'${font.replace(/'/g, "\\'")}',Arial,Helvetica,sans-serif !important;}${WATERMARK}</style>`;
    if (!SYSTEM_FONTS.includes(font)) style += `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${font.replace(/ /g, "+")}:wght@400;600;700&display=swap">`;
    html = html.replace("</head>", `${style}</head>`);
    return orgName ? html.replace(/<body([^>]*)>/i, `<body$1><div class="r2k-watermark">${e(orgName)}</div>`) : html;
  }

  // _buildSignatureHtml — a drawn (data URL) or uploaded signature, else the blank space
  private async signatureHtml(signatureUID: number): Promise<string> {
    if (signatureUID <= 0) return SIGNATURE_SPACE;
    const signature = await this.lookups.signature(signatureUID);
    if (!signature) return SIGNATURE_SPACE;
    let src: string;
    if (s(signature.SignatureType).toLowerCase() === "draw" && signature.DrawData) {
      const raw = s(signature.DrawData);
      src = raw.startsWith("data:image/") ? raw : `data:${s(signature.MimeType) || "image/png"};base64,${raw}`;
    } else if (signature.ImagePath) {
      src = resolveCdnUrl(s(signature.ImagePath));
    } else {
      return SIGNATURE_SPACE;
    }
    return `<div style="text-align:center;padding-top:8px;min-height:65px;"><img src="${src}" alt="Signature" style="max-height:55px;max-width:160px;display:block;margin:0 auto;" /></div>`;
  }

  // _processLoops — {{FOREACH:ITEMS}}…{{/FOREACH:ITEMS}} once per line
  private static itemLoops(html: string, items: Row[], cur: string): string {
    return html.replace(/\{\{FOREACH:ITEMS\}\}([\s\S]*?)\{\{\/FOREACH:ITEMS\}\}/g, (_match, rowTemplate: string) =>
      items
        .map((item, i) => {
          const tax = phpRound(n(item.CgstAmount) + n(item.SgstAmount) + n(item.IgstAmount), 2);
          const map: Record<string, string> = {
            "{{ITEM.SNO}}": String(i + 1),
            "{{ITEM.PRODUCT_NAME}}": e(item.ProductName),
            "{{ITEM.HSN_CODE}}": e(item.HSNCode ?? item.HSNSACCode),
            "{{ITEM.UNIT_PRICE}}": cur + fixed(n(item.UnitPrice)),
            "{{ITEM.QTY}}": e(item.Quantity),
            "{{ITEM.UNIT}}": e(item.PrimaryUnitName),
            "{{ITEM.TAXABLE_VALUE}}": cur + fixed(phpRound(n(item.UnitPrice) * n(item.Quantity), 2)),
            "{{ITEM.TAX_PCT}}": grouped(n(item.TaxPercentage), 2),
            "{{ITEM.TAX_AMT}}": cur + fixed(tax),
            "{{ITEM.NET_AMOUNT}}": cur + fixed(n(item.NetAmount)),
            "{{ITEM.DISCOUNT}}": cur + fixed(n(item.DiscountAmount)),
            "{{ITEM.PART_NUMBER}}": e(item.PartNumber),
          };
          return Object.entries(map).reduce((row, [token, value]) => row.split(token).join(value), rowTemplate);
        })
        .join("")
    );
  }

  // _processHsnSummary — {{FOREACH:HSN_SUMMARY}} once per HSN code + tax rate
  private static hsnSummary(html: string, items: Row[]): string {
    return html.replace(/\{\{FOREACH:HSN_SUMMARY\}\}([\s\S]*?)\{\{\/FOREACH:HSN_SUMMARY\}\}/g, (_match, rowTemplate: string) => {
      const groups = new Map<string, { hsn: string; taxPct: number; taxable: number; cgst: number; sgst: number; igst: number }>();
      for (const item of items) {
        const hsn = s(item.HSNCode ?? item.HSNSACCode);
        const taxPct = n(item.TaxPercentage);
        const key = `${hsn}||${taxPct}`;
        const group = groups.get(key) ?? { hsn, taxPct, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
        group.taxable += phpRound(n(item.UnitPrice) * n(item.Quantity), 2);
        group.cgst += n(item.CgstAmount);
        group.sgst += n(item.SgstAmount);
        group.igst += n(item.IgstAmount);
        groups.set(key, group);
      }
      return [...groups.values()]
        .map((group, i) => {
          const [cgst, sgst, igst] = [phpRound(group.cgst, 2), phpRound(group.sgst, 2), phpRound(group.igst, 2)];
          const total = phpRound(cgst + sgst + igst, 2);
          const map: Record<string, string> = {
            "{{HSN.SNO}}": String(i + 1),
            "{{HSN.CODE}}": e(group.hsn),
            "{{HSN.TAXABLE_VALUE}}": fixed(group.taxable),
            "{{HSN.TAX_RATE}}": grouped(group.taxPct, 0),
            "{{HSN.CGST_RATE}}": grouped(group.taxPct / 2, 0),
            "{{HSN.SGST_RATE}}": grouped(group.taxPct / 2, 0),
            "{{HSN.IGST_RATE}}": grouped(group.taxPct, 0),
            "{{HSN.CGST_AMT}}": fixed(cgst),
            "{{HSN.SGST_AMT}}": fixed(sgst),
            "{{HSN.IGST_AMT}}": fixed(igst),
            "{{HSN.TAX_AMT}}": fixed(total),
            "{{HSN.TOTAL_TAX}}": fixed(total),
          };
          return Object.entries(map).reduce((row, [token, value]) => row.split(token).join(value), rowTemplate);
        })
        .join("");
    });
  }

  // _renderGenericA4Html — the built-in A4 layout
  private static genericA4(h: Row, items: Row[], org: Row, ctx: PrintContext): string {
    const cur = ctx.currency;
    const showDate = (value: unknown) => {
      const date = parseDateTime(s(value));
      return date ? phpDate(ctx.printDateFormat, date, "UTC") : s(value) || "—";
    };
    const label = s(h.TransType ?? "Document").toUpperCase();
    const partyLabel = ["PURCHASE ORDER", "PURCHASE BILL"].includes(label) ? "Vendor" : "Customer";
    const rows = items
      .map(
        (item, i) =>
          `<tr><td style="text-align:center">${i + 1}</td><td>${e(item.ProductName)}</td><td style="text-align:center">${smartDecimal(item.Quantity ?? 0)} ${e(item.PrimaryUnitName)}</td>` +
          `<td style="text-align:right">${cur}${fixed(n(item.UnitPrice))}</td><td style="text-align:right">${cur}${fixed(n(item.NetAmount))}</td></tr>`
      )
      .join("");
    return (
      '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:A4;margin:0;}body{font-family:Arial,sans-serif;font-size:12px;margin:0;padding:0;background:#fff;}' +
      ".page{padding:15mm;}table{width:100%;border-collapse:collapse;}th,td{border:1px solid #ddd;padding:6px 8px;font-size:11px;}th{background:#f5f5f5;font-weight:bold;}" +
      '@media print{body{background:#fff;}}</style></head><body><div class="page"><div style="display:flex;justify-content:space-between;margin-bottom:12px">' +
      `<div><strong style="font-size:14px">${e(org.BrandName ?? org.Name)}</strong>${org.GSTIN ? `<br><span style="color:#666">GSTIN: ${e(org.GSTIN)}</span>` : ""}</div>` +
      `<div style="text-align:right"><strong style="font-size:16px">${label}</strong><br><span style="color:#666">${e(h.UniqueNumber ?? "—")}</span><br>` +
      `<span style="color:#666">Date: ${showDate(h.TransDate)}</span>${h.ValidityDate ? `<br><span style="color:#666">Valid Until: ${showDate(h.ValidityDate)}</span>` : ""}</div></div>` +
      `<div style="background:#f9f9f9;padding:8px;border-radius:4px;margin-bottom:12px"><strong>${partyLabel}:</strong> ${e(h.PartyName ?? "—")}</div>` +
      '<table><thead><tr><th style="width:30px">#</th><th>Product</th><th style="width:60px;text-align:center">Qty</th><th style="width:90px;text-align:right">Unit Price</th>' +
      `<th style="width:90px;text-align:right">Amount</th></tr></thead><tbody>${rows}</tbody><tfoot>` +
      `<tr><td colspan="4" style="text-align:right;font-weight:bold">Sub Total</td><td style="text-align:right">${cur}${fixed(n(h.SubTotal))}</td></tr>` +
      (n(h.DiscountAmount) > 0 ? `<tr><td colspan="4" style="text-align:right;color:#c00">Discount</td><td style="text-align:right;color:#c00">- ${cur}${fixed(n(h.DiscountAmount))}</td></tr>` : "") +
      (n(h.TaxAmount) > 0 ? `<tr><td colspan="4" style="text-align:right">Tax</td><td style="text-align:right">${cur}${fixed(n(h.TaxAmount))}</td></tr>` : "") +
      `<tr><td colspan="4" style="text-align:right;font-weight:bold">Net Amount</td><td style="text-align:right;font-weight:bold">${cur}${fixed(n(h.NetAmount))}</td></tr>` +
      "</tfoot></table>" +
      (h.Notes ? `<p style="margin-top:12px;font-size:11px;color:#666"><strong>Notes:</strong> ${e(h.Notes)}</p>` : "") +
      (h.TermsConditions ? `<p style="font-size:11px;color:#666"><strong>Terms:</strong> ${e(h.TermsConditions)}</p>` : "") +
      "</div></body></html>"
    );
  }
}
