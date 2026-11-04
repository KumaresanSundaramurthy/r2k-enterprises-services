import { Injectable } from "@nestjs/common";
import { escapeHtml, parseDateTime, phpDate, smartDecimal } from "../../common/utils/php-compat";
import { applyTokens, numberToWords } from "../../common/utils/print-tokens";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { PaymentRecordsRepository } from "./payment-records.repository";
import { PAYMENTS_MODULE } from "./payment-write.service";

type Row = Record<string, unknown>;

// Document title and number label by the payment's module
const DOC_TYPES: Record<number, string> = { 103: "Payment Receipt", 105: "Payment Voucher", 106: "Refund Receipt", 108: "Refund Voucher", 114: "Expense Payment", 115: "Income Receipt" };
const NUMBER_LABELS: Record<number, string> = { 103: "Receipt No.", 105: "Voucher No.", 106: "Refund No.", 108: "Refund No.", 114: "Payment No.", 115: "Receipt No." };
const INVOICE_MODULE = 103;

// The signature is chosen by SignatureUID, which the payment query never selects, so CI3 always shows the blank space
const SIGNATURE_SPACE = '<div style="min-height:65px;"></div>';
const WATERMARK_STYLE =
  ".r2k-watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-45deg);font-size:72px;font-weight:800;letter-spacing:4px;color:rgba(0,0,0,0.045);white-space:nowrap;pointer-events:none;z-index:9999;}";

const e = (value: unknown) => escapeHtml(String(value ?? ""));
const text = (value: unknown) => String(value ?? "");

/**
 * Payment receipts (CI3 Payments::getPaymentPrintDetail and Transactions_model::_renderPaymentReceiptHtml): the
 * organisation's Payment print template with its {{TOKENS}} filled in, or a built-in A4 layout.
 */
@Injectable()
export class PaymentReceiptService {
  constructor(
    private readonly repo: PaymentRecordsRepository,
    private readonly orgInfo: OrgInfoCacheService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // getPaymentPrintDetail — PrintType thermal: the thermal config; otherwise the theme and the receipt HTML
  async printDetail(orgUID: number, paymentUID: number, printType: string) {
    const payment = await this.livePayment(orgUID, paymentUID);
    const org = await this.orgInfo.get(orgUID);
    if (printType === "thermal") {
      return { Payment: payment, OrgInfo: org, ThermalConfig: await this.repo.thermalConfig(orgUID, PAYMENTS_MODULE) };
    }
    const theme = await this.repo.printTheme(orgUID, "Payment");
    return { Payment: payment, OrgInfo: org, PrintTheme: theme, PrintHtml: await this.render(orgUID, payment, org ?? {}, theme ?? {}) };
  }

  /**
   * downloadPaymentPdf / getPaymentPdfBase64. CI3's PDF builder never returned its output, so both always
   * answered "Failed to generate PDF."; there is no PDF renderer here yet, so they answer the same.
   */
  async pdf(orgUID: number, paymentUID: number): Promise<never> {
    await this.livePayment(orgUID, paymentUID);
    throw new CiValidationError("Failed to generate PDF.");
  }

  private async livePayment(orgUID: number, paymentUID: number): Promise<Row> {
    if (paymentUID <= 0) throw new CiValidationError("Invalid payment.");
    const payment = await this.repo.detail(orgUID, paymentUID);
    if (!payment) throw new CiValidationError("Payment not found.");
    return payment;
  }

  // _renderPaymentReceiptHtml
  private async render(orgUID: number, p: Row, org: Row, theme: Row): Promise<string> {
    const [{ printDateFormat, currency }, settings] = await Promise.all([this.repo.printSettings(orgUID), this.orgSettings.get(orgUID)]);
    const showDate = (value: unknown) => {
      const date = parseDateTime(text(value));
      return date ? phpDate(printDateFormat, date, "UTC") : text(value) || "—";
    };
    const amount = (value: unknown) => smartDecimal(Number(value) || 0);

    const isCustomer = p.PartyType === "C";
    const direction = isCustomer ? "Payment Received" : "Payment Made";
    const moduleUID = Number(p.ModuleUID ?? 0);
    const docType = DOC_TYPES[moduleUID] ?? direction;
    const isInvoicePayment = (Number(p.TransModuleUID ?? 0) === INVOICE_MODULE || moduleUID === INVOICE_MODULE) && Number(p.TransUID ?? 0) > 0;
    const summary = isInvoicePayment ? await this.repo.invoiceSummary(orgUID, Number(p.TransUID), Number(p.PaymentUID)) : null;

    const orgName = text(org.BrandName ?? org.Name);
    const orgAddress = [org.Line1, org.Line2, org.CityText, org.StateText, org.Pincode].map(text).filter(Boolean).join(", ");
    const cityState = [org.CityText, org.StateText].map(text).filter(Boolean).join(", ");
    const cityPin = [e(cityState), e(org.Pincode)].filter(Boolean).join(" - ");
    const infoLines = [e(org.Line1), e(org.Line2), cityPin, org.GSTIN ? `<b>GSTIN:</b> ${e(org.GSTIN)}` : ""].filter(Boolean).join("<br>");
    const logoHtml = org.Logo ? `<img src="${e(org.Logo)}" style="max-width:100px;max-height:100px;" alt="Logo">` : "";
    const bankLine = Number(p.IsCash) !== 1 && p.BankName ? e(p.BankName) + (p.AccountName ? ` (${e(p.AccountName)})` : "") : "";

    let html: string;
    if (theme.TemplateHtmlContent) {
      const createdOn = parseDateTime(text(p.CreatedOn));
      const tokens: Record<string, string> = {
        "{{PRIMARY_COLOR}}": text(theme.PrimaryColor ?? "#1a3c6e"),
        "{{ACCENT_COLOR}}": text(theme.AccentColor ?? "#f59e0b"),
        "{{FONT_FAMILY}}": text(theme.FontFamily ?? "Arial"),
        "{{FONT_SIZE_PX}}": `${theme.FontSizePx ?? 11}px`,
        "{{FONT_SIZE}}": `${theme.FontSizePx ?? 11}px`,
        "{{ORG_LOGO}}": logoHtml,
        "{{ORG_NAME}}": e(orgName),
        "{{ORG_GSTIN}}": e(org.GSTIN),
        "{{ORG_ADDRESS}}": e(orgAddress),
        "{{ORG_ADDRESS_1}}": e(org.Line1),
        "{{ORG_ADDRESS_2}}": e(org.Line2),
        "{{ORG_CITY_STATE}}": e(cityState),
        "{{ORG_PINCODE}}": e(org.Pincode),
        "{{ORG_INFO_LINES}}": infoLines,
        "{{ORG_PHONE}}": e(org.MobileNumber),
        "{{ORG_EMAIL}}": e(org.EmailAddress),
        // The organisation's print bank account is not passed to the receipt in CI3, so these stay empty
        "{{ORG_BANK_NAME}}": "",
        "{{ORG_ACCOUNT_NO}}": "",
        "{{ORG_IFSC}}": "",
        "{{ORG_BRANCH}}": "",
        "{{ORG_UPI_ID}}": "",
        "{{BANK_DETAILS_LINES}}": "",
        "{{PLACE_OF_SUPPLY}}": e(org.StateText),
        "{{DOC_TYPE}}": e(docType),
        "{{DOC_NUMBER_LABEL}}": e(NUMBER_LABELS[moduleUID] ?? "Payment No."),
        "{{PAYMENT_DIRECTION}}": e(direction),
        "{{DOC_NUMBER}}": e(p.UniqueNumber ?? `PMT-${p.PaymentUID}`),
        "{{DOC_DATE}}": showDate(p.PaymentDate ?? p.CreatedOn),
        "{{IS_PARTY}}": p.PartyName ? "1" : "",
        "{{PARTY_LABEL}}": isCustomer ? "Customer" : "Vendor",
        "{{PARTY_NAME}}": e(p.PartyName),
        "{{PARTY_ADDRESS}}": e(p.PartyArea),
        "{{PARTY_PHONE}}": e(p.PartyMobile),
        "{{PARTY_GSTIN}}": e(p.PartyGSTIN),
        "{{BILLING_ADDRESS}}": e(p.PartyArea),
        "{{LINKED_DOC}}": e(p.TransNumber),
        "{{BILL_AMOUNT}}": Number(p.BillAmount) ? amount(p.BillAmount) : "",
        "{{AMOUNT}}": amount(p.Amount),
        "{{NET_AMOUNT}}": amount(p.Amount),
        "{{TOTAL_AMOUNT}}": amount(p.Amount),
        "{{AMOUNT_IN_WORDS}}": numberToWords(Number(p.Amount) || 0),
        "{{PAYMENT_MODE}}": e(p.PaymentTypeName ?? "—"),
        "{{BANK_LINE}}": bankLine,
        "{{BANK_NAME}}": e(p.BankName),
        "{{BANK_ACCOUNT_NAME}}": e(p.AccountName),
        "{{ACCOUNT_NUMBER}}": e(p.AccountNumber),
        "{{BANK_IFSC}}": e(p.IFSC),
        "{{BANK_BRANCH}}": e(p.BranchName),
        "{{REFERENCE_NO}}": e(p.ReferenceNo),
        "{{REFERENCE}}": e(p.ReferenceNo),
        "{{TRANSACTION_REF}}": e(p.ReferenceNo),
        "{{RECORDED_BY}}": e(p.CreatedByName),
        "{{RECEIVED_BY}}": e(p.CreatedByName),
        "{{BANK_ACCOUNT_NO}}": "",
        "{{BANK_UPI_ID}}": "",
        "{{BANK_QR_HTML}}": "",
        "{{SIGNATURE_SPACE}}": SIGNATURE_SPACE,
        "{{NOTES}}": e(p.Notes),
        "{{DOC_TIME}}": createdOn && Number(theme.ShowTime ?? 0) ? phpDate("h:i A", createdOn, settings.Timezone) : "",
        "{{FOOTER_TEXT}}": e(theme.FooterText ?? "Thank you for your business!"),
        "{{CURRENCY}}": currency,
        "{{PAYMENTS_REF}}": `Amount received ${p.TransNumber ? "against the linked document " : ""}as <b>${e(p.TransNumber)}</b>`,
        "{{COPY_LABEL}}": "__COPY_LABEL__",
        "{{INVOICE_SUMMARY}}": isInvoicePayment ? "1" : "",
        "{{INVOICE_NUMBER}}": summary ? e(summary.invoiceNumber) : "",
        "{{INVOICE_DATE}}": summary ? showDate(summary.invoiceDate) : "",
        "{{PREVIOUS_BALANCE}}": summary ? amount(summary.outstandingBefore) : "",
        "{{PARTY_CLOSING_BALANCE}}": summary ? amount(Math.max(0, summary.outstandingBefore - Number(p.Amount ?? 0))) : "",
      };
      const font = text(theme.FontFamily ?? "Arial").replace(/'/g, "\\'");
      const style = `<style>@page{size:A4;margin:0;}body{font-family:'${font}',Arial,sans-serif;font-size:${parseInt(text(theme.FontSizePx ?? 11), 10) || 0}px;}@media print{body{background:#fff;}}${WATERMARK_STYLE}</style>`;
      html = applyTokens(text(theme.TemplateHtmlContent), tokens).replace("</head>", `${style}</head>`);
    } else {
      html = PaymentReceiptService.staticReceipt(p, theme, { orgName, orgAddress, logoHtml, docType, partyLabel: isCustomer ? "Customer" : "Vendor", bankLine, date: showDate(p.PaymentDate ?? p.CreatedOn), amount: amount(p.Amount) });
      html = html.replace("</head>", `<style>${WATERMARK_STYLE}</style></head>`);
    }
    return orgName ? html.replace(/<body([^>]*)>/i, `<body$1><div class="r2k-watermark">${e(orgName)}</div>`) : html;
  }

  // _getStaticPaymentReceiptTemplate — the built-in A4 receipt when the organisation has no Payment template
  private static staticReceipt(
    p: Row,
    theme: Row,
    v: { orgName: string; orgAddress: string; logoHtml: string; docType: string; partyLabel: string; bankLine: string; date: string; amount: string }
  ): string {
    const primary = text(theme.PrimaryColor ?? "#1a3c6e");
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
                @page{size:A4;margin:10mm 5mm;}
                body{font-family:'${e(theme.FontFamily ?? "Arial")}',Arial,sans-serif;font-size:11px;margin:0;padding:0;background:#fff;}
                table{border-collapse:collapse;width:100%;}
                .page{padding:6mm 8mm;}
                .org-name{font-size:16px;font-weight:700;color:${primary};}
                .receipt-title{font-size:20px;font-weight:800;color:${primary};}
                .amount-box{background:${primary};color:#fff;border-radius:4px;padding:10px;text-align:center;margin:10px 0;}
                .amount-val{font-size:24px;font-weight:800;}
                .info-card{border:1px solid #e5e7eb;border-radius:4px;padding:8px;vertical-align:top;}
                .footer-row{margin-top:14px;text-align:center;font-size:10px;color:#888;}
            </style></head><body>
            <div class="page">
                <table style="border-bottom:3px solid ${primary};padding-bottom:8px;margin-bottom:10px;">
                    <tr>
                        <td style="vertical-align:top;">${v.logoHtml ? `${v.logoHtml}<br>` : ""}<div class="org-name">${e(v.orgName)}</div>
                            <div style="font-size:10px;">${e(v.orgAddress)}</div>
                        </td>
                        <td style="text-align:right;vertical-align:top;">
                            <div class="receipt-title">${e(v.docType)}</div>
                            <div>${e(p.UniqueNumber)}</div>
                            <div>${v.date}</div>
                        </td>
                    </tr>
                </table>
                <div class="amount-box">
                    <div>Amount</div>
                    <div class="amount-val">${v.amount}</div>
                </div>
                <table style="margin-bottom:8px;">
                    <tr>
                        <td width="49%" class="info-card">
                            <b>${e(v.partyLabel)}</b><br>
                            ${e(p.PartyName ?? "—")}<br>${p.PartyMobile ? `Ph: ${e(p.PartyMobile)}` : ""}
                        </td>
                        <td width="2%"></td>
                        <td width="49%" class="info-card">
                            <b>Payment</b><br>
                            Mode: ${e(p.PaymentTypeName)}<br>${v.bankLine ? `Bank: ${v.bankLine}<br>` : ""}
                            Ref: ${e(p.ReferenceNo)}
                        </td>
                    </tr>
                </table>
                ${p.Notes ? `<div style="margin-top:8px;"><b>Notes:</b> ${e(p.Notes)}</div>` : ""}
                <table style="margin-top:14px;">
                    <tr>
                        <td style="vertical-align:bottom;"></td>
                        <td style="text-align:right;vertical-align:bottom;">
                            For ${e(v.orgName)}<br><br>${SIGNATURE_SPACE}
                            Authorized Signatory
                        </td>
                    </tr>
                </table>
                <div class="footer-row">${e(theme.FooterText ?? "Thank you for your business!")}</div>
            </div>
        </body></html>`;
  }
}
