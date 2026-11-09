import { Injectable } from "@nestjs/common";
import { appUrl } from "../../auth/utils/app-url";
import { phpDate, smartDecimal } from "../../common/utils/php-compat";
import { numberToWords } from "../../common/utils/print-tokens";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { CacheHelperService } from "../../libraries/cache-helper/cache-helper.service";
import { CreditSettingsService } from "../../libraries/credit-settings/credit-settings.service";
import { CurlService } from "../../libraries/curl/curl.service";
import { LocationService } from "../../libraries/location/location.service";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { GloballyRepository } from "./globally.repository";

type Row = Record<string, unknown>;
type Context = Record<string, string | number>;

const PAYMENTS_MODULE = 110;
const INVOICES_MODULE = 103;

// 'YYYY-MM-DD[ HH:MM:SS]' → that wall-clock moment as a UTC Date; null when empty or not a date
function wallClock(value: unknown): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value ?? ""));
  if (!match) return null;
  const [, y, m, d, h = "0", i = "0", s = "0"] = match;
  return new Date(Date.UTC(+y, +m - 1, +d, +h, +i, +s));
}

// "123 Business Park, Mumbai — 400001" → address line, city and pincode
function splitGstinAddress(raw: string): { line1: string; city: string; pincode: string } {
  const address = raw.trim();
  const dash = address.indexOf("—");
  if (dash === -1) return { line1: address, city: "", pincode: "" };
  const left = address.slice(0, dash).trim();
  const pincode = address.slice(dash + 1).replace(/\D/g, "");
  const comma = left.lastIndexOf(",");
  return comma === -1 ? { line1: left, city: "", pincode } : { line1: left.slice(0, comma).trim(), city: left.slice(comma + 1).trim(), pincode };
}

/**
 * Shared lookups of CI3's Globally controller: countries / states / cities, timezones, GSTIN and IFSC lookups and
 * the email / message template filled with a record's details.
 */
@Injectable()
export class GloballyService {
  constructor(
    private readonly repo: GloballyRepository,
    private readonly location: LocationService,
    private readonly curl: CurlService,
    private readonly orgSettings: OrgSettingsService,
    private readonly orgInfo: OrgInfoCacheService,
    private readonly creditSettings: CreditSettingsService,
    private readonly cacheHelper: CacheHelperService
  ) {}

  // getCountryInfo
  async getCountryInfo() {
    return { Message: "Data Retrieved Successfully", Data: await this.location.countries() };
  }

  // getStateCityOfCountry — the country's states (as StateInfo)
  async getStateCityOfCountry(countryCode: string) {
    const code = countryCode.trim().toUpperCase();
    if (!code) throw new CiValidationError("Country Code information is missing.");
    return { Message: "Data Retrieved Successfully", StateInfo: await this.location.states(code) };
  }

  // getStateofCountry — the country's states (as Data)
  async getStateofCountry(countryCode: string) {
    const code = countryCode.trim().toUpperCase();
    if (!code) throw new CiValidationError("Country Code information is missing.");
    return { Message: "Data Retrieved Successfully", Data: await this.location.states(code) };
  }

  // getCitiesOfState
  async getCitiesOfState(countryISO2: string, stateISO2: string) {
    if (!countryISO2.trim() || !stateISO2.trim()) throw new CiValidationError("Country and State codes are required.");
    return { Data: await this.location.citiesOfState(countryISO2, stateISO2) };
  }

  // getTimezones
  async getTimezones() {
    return { Data: await this.repo.timezones() };
  }

  /**
   * fetchGstinDetails — refused when the org has no GSTIN credit points; a successful lookup uses one point and
   * refreshes the {org}-credit-settings cache (GstinPoints is returned).
   */
  async fetchGstinDetails(orgUID: number, gstinInput: string) {
    const gstin = gstinInput.trim().toUpperCase();
    if (gstin.length !== 15) throw new CiValidationError("Please enter a valid 15-character GSTIN.");

    const org = await this.orgSettings.get(orgUID);
    const credit = await this.creditSettings.find(orgUID);
    if (credit && Number(credit.GstinPoints ?? 0) <= 0) {
      throw new CiValidationError("You don't have credit points to fetch GSTIN details. Please purchase more credits to get the information.", { NoCreditPoints: true });
    }

    const result = await this.curl.request<Record<string, unknown>>(`https://gstverify.co.in/api/v1/verify/${encodeURIComponent(gstin)}`, {
      headers: { Accept: "application/json", "X-API-Key": process.env.GSTIN_API_KEY || "" },
      timeoutMs: 15000,
    });
    if (result.error || !result.data) throw new CiValidationError("Failed to reach GSTIN lookup service. Please try again.");
    const body = result.data;
    if (body.success !== true) {
      const apiMessage = [body.message, body.error, body.msg].find((value) => typeof value === "string" && value);
      throw new CiValidationError((apiMessage as string) || "GSTIN not found or invalid. Please verify the number.");
    }

    // One point used; the cache shows the new balance (a failure here does not fail the lookup)
    let points: number | undefined;
    try {
      await this.repo.useGstinPoint(orgUID);
      const fresh = await this.creditSettings.find(orgUID);
      if (fresh) {
        points = Number(fresh.GstinPoints ?? 0);
        await this.cacheHelper.storeCreditSettings(org.OrgToken, String(fresh.CustomerNextNumber ?? ""), points);
      }
    } catch {
      points = undefined;
    }

    const d = (body.data ?? {}) as Record<string, string | undefined>;
    const address = splitGstinAddress(d.address ?? "");
    return {
      ...(points !== undefined ? { GstinPoints: points } : {}),
      GSTIN: gstin,
      LegalName: d.legal_name ?? "",
      TradeName: d.trade_name ?? d.legal_name ?? "",
      Status: d.status ?? "",
      PAN: d.pan ?? "",
      Constitution: d.constitution ?? "",
      TaxpayerType: d.taxpayer_type ?? "",
      RegistrationDate: d.registration_date ?? "",
      StateCode: gstin.slice(0, 2),
      StateName: d.state ?? "",
      City: address.city,
      Pincode: address.pincode,
      AddressLine1: address.line1,
      AddressLine2: "",
    };
  }

  // fetchIfscDetails — bank and branch of an IFSC code (Razorpay's public IFSC API)
  async fetchIfscDetails(ifscInput: string) {
    const ifsc = ifscInput.trim().toUpperCase();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new CiValidationError("Please enter a valid 11-character IFSC code.");
    const result = await this.curl.request<Record<string, string>>(`https://ifsc.razorpay.com/${encodeURIComponent(ifsc)}`, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      timeoutMs: 15000,
    });
    if (result.error) throw new CiValidationError("Failed to reach IFSC lookup service. Please try again.");
    const data = result.data;
    if (!data || !data.BANK) throw new CiValidationError("IFSC code not found. Please verify the code.");
    return { IFSC: ifsc, Bank: data.BANK ?? "", Branch: data.BRANCH ?? "", City: data.CITY ?? "", State: data.STATE ?? "", Address: data.ADDRESS ?? "" };
  }

  /**
   * getCommTemplate — the org's template for the module and channel, with {{TOKENS}} filled from the record
   * (payments 110, invoices 103). Found false when no template is set up.
   */
  async getCommTemplate(orgUID: number, moduleUID: number, channel: string, recordUID: number) {
    if (!moduleUID) throw new CiValidationError("ModuleUID required.");
    await this.orgSettings.get(orgUID);
    const template = await this.repo.messageTemplate(orgUID, moduleUID, channel || "Email");
    if (!template) return { Found: false, Subject: "", Body: "", RawSubject: "", RawBody: "" };

    const rawSubject = String(template.Subject ?? "");
    const rawBody = String(template.Body ?? "");
    const settings = await this.repo.displaySettings(orgUID);
    const context = await this.context(orgUID, moduleUID, recordUID, settings.dateFormat);
    const tokens = this.tokens(moduleUID, context, settings.currency);
    const fill = (text: string) => Object.entries(tokens).reduce((out, [token, value]) => out.split(token).join(value), text);
    return { Found: true, Subject: fill(rawSubject), Body: fill(rawBody), RawSubject: rawSubject, RawBody: rawBody };
  }

  // _buildCommContext — org details, then the payment's or invoice's details
  private async context(orgUID: number, moduleUID: number, recordUID: number, dateFormat: string): Promise<Context> {
    const context: Context = {};
    if (recordUID <= 0) return context;
    const date = (value: unknown) => {
      const at = wallClock(value);
      return at ? phpDate(dateFormat, at, "UTC") : "";
    };

    const org = (await this.orgInfo.get(orgUID)) as Row | null;
    if (org) {
      context.OrgName = String(org.BrandName || org.Name || "");
      context.OrgPhone = String(org.MobileNumber ?? "");
      context.OrgEmail = String(org.EmailAddress ?? "");
      context.OrgGSTIN = String(org.GSTIN ?? "");
      context.OrgAddress = [org.Line1, org.Line2, org.CityText, org.StateText, org.Pincode].map((part) => String(part ?? "")).filter(Boolean).join(", ");
    }

    if (moduleUID === PAYMENTS_MODULE) {
      const payment = await this.repo.payment(orgUID, recordUID);
      if (!payment) return context;
      const linkedDoc = String(payment.TransNumber ?? "").trim();
      const token = String(payment.ReceiptToken ?? "").trim();
      Object.assign(context, {
        PartyName: String(payment.PartyName ?? ""),
        DocNumber: linkedDoc,
        DocDate: date(payment.PaymentDate || payment.CreatedOn),
        Amount: Number(payment.Amount ?? 0),
        AmountInWords: numberToWords(Number(payment.Amount ?? 0)),
        ReceiptNumber: String(payment.UniqueNumber ?? ""),
        PaymentMode: String(payment.PaymentTypeName ?? ""),
        PaymentStatus: Number(payment.IsFullyPaid ?? 0) ? "Paid" : "Partially Paid",
        ReceiptLink: token ? appUrl(`receipt/${token}`) : "",
        BalanceAmount: Number(payment.BalanceAmount ?? 0),
        ReceiptDescription: linkedDoc ? `Amount received against the linked document ${linkedDoc}` : "Amount received",
      });
    }

    if (moduleUID === INVOICES_MODULE) {
      const invoice = await this.repo.invoice(orgUID, recordUID);
      if (!invoice) return context;
      const paid = Number(invoice.PaidAmount ?? 0);
      const net = Number(invoice.NetAmount ?? 0);
      const balance = Math.max(0, net - paid);
      const token = String(invoice.TransToken ?? "").trim();
      const invoiceDate = date(invoice.TransDate || invoice.CreatedOn);
      const dueDate = date(invoice.ValidityDate);
      Object.assign(context, {
        PartyName: String(invoice.PartyName ?? ""),
        DocNumber: String(invoice.UniqueNumber ?? ""),
        DocDate: invoiceDate,
        DocType: "Invoice",
        Amount: net,
        AmountInWords: numberToWords(net),
        ValidUntil: dueDate,
        InvoiceNumber: String(invoice.UniqueNumber ?? ""),
        InvoiceDate: invoiceDate,
        DueDate: dueDate,
        PaymentStatus: paid > 0 && balance <= 0.01 ? "Paid" : paid > 0 ? "Partially Paid" : "Pending",
        PaidAmount: paid,
        BalanceAmount: balance,
        InvoiceLink: token ? appUrl(`invoice/${token}`) : "",
        SubTotal: Number(invoice.SubTotal ?? 0),
        TaxAmount: Number(invoice.TaxAmount ?? 0),
        DiscountAmount: Number(invoice.DiscountAmount ?? 0),
      });
    }
    return context;
  }

  // _resolveCommTokens — common tokens (UPPER_CASE and camelCase), then the module's own
  private tokens(moduleUID: number, context: Context, currency: string): Record<string, string> {
    const text = (key: string) => (context[key] === undefined ? "" : String(context[key]));
    const money = (key: string) => (context[key] === undefined ? "" : smartDecimal(Number(context[key])));
    const amount = money("Amount");
    const map: Record<string, string> = {
      "{{PARTY_NAME}}": text("PartyName"),
      "{{DOC_NUMBER}}": text("DocNumber"),
      "{{DOC_DATE}}": text("DocDate"),
      "{{DOC_TYPE}}": text("DocType"),
      "{{AMOUNT}}": amount,
      "{{AMOUNT_IN_WORDS}}": text("AmountInWords"),
      "{{CURRENCY}}": currency,
      "{{VALID_UNTIL}}": text("ValidUntil"),
      "{{ORG_NAME}}": text("OrgName"),
      "{{ORG_PHONE}}": text("OrgPhone"),
      "{{ORG_EMAIL}}": text("OrgEmail"),
      "{{ORG_GSTIN}}": text("OrgGSTIN"),
      "{{ORG_ADDRESS}}": text("OrgAddress"),
      "{{PartyName}}": text("PartyName"),
      "{{DocNumber}}": text("DocNumber"),
      "{{DocDate}}": text("DocDate"),
      "{{Amount}}": amount,
      "{{AmountInWords}}": text("AmountInWords"),
      "{{CompanyName}}": text("OrgName"),
      "{{CompanyMobile}}": text("OrgPhone"),
      "{{CompanyEmail}}": text("OrgEmail"),
      "{{CompanyGSTIN}}": text("OrgGSTIN"),
      "{{CompanyAddress}}": text("OrgAddress"),
    };

    if (moduleUID === PAYMENTS_MODULE) {
      const balance = money("BalanceAmount");
      Object.assign(map, {
        "{{RECEIPT_NUMBER}}": text("ReceiptNumber"),
        "{{PAYMENT_MODE}}": text("PaymentMode"),
        "{{PAYMENT_STATUS}}": text("PaymentStatus"),
        "{{RECEIPT_LINK}}": text("ReceiptLink"),
        "{{BALANCE_AMOUNT}}": balance,
        "{{RECEIPT_DESCRIPTION}}": text("ReceiptDescription"),
        "{{ReceiptNo}}": text("ReceiptNumber"),
        "{{ReceiptNumber}}": text("ReceiptNumber"),
        "{{ReceiptDate}}": text("DocDate"),
        "{{PaymentMode}}": text("PaymentMode"),
        "{{PaymentStatus}}": text("PaymentStatus"),
        "{{AmountReceived}}": amount,
        "{{ReceiptLink}}": text("ReceiptLink"),
        "{{BalanceAmount}}": balance,
        "{{ReceiptDescription}}": text("ReceiptDescription"),
        "{{CustomerName}}": text("PartyName"),
        "{{InvoiceNumber}}": text("DocNumber"),
      });
    }

    if (moduleUID === INVOICES_MODULE) {
      const [balance, paid, subTotal, tax, discount] = ["BalanceAmount", "PaidAmount", "SubTotal", "TaxAmount", "DiscountAmount"].map(money);
      Object.assign(map, {
        "{{INVOICE_NUMBER}}": text("InvoiceNumber"),
        "{{INVOICE_DATE}}": text("InvoiceDate"),
        "{{DUE_DATE}}": text("DueDate"),
        "{{PAYMENT_STATUS}}": text("PaymentStatus"),
        "{{PAID_AMOUNT}}": paid,
        "{{BALANCE_AMOUNT}}": balance,
        "{{INVOICE_LINK}}": text("InvoiceLink"),
        "{{SUB_TOTAL}}": subTotal,
        "{{TAX_AMOUNT}}": tax,
        "{{DISCOUNT_AMOUNT}}": discount,
        "{{InvoiceNumber}}": text("InvoiceNumber"),
        "{{InvoiceDate}}": text("InvoiceDate"),
        "{{DueDate}}": text("DueDate"),
        "{{PaymentStatus}}": text("PaymentStatus"),
        "{{PaidAmount}}": paid,
        "{{BalanceAmount}}": balance,
        "{{InvoiceLink}}": text("InvoiceLink"),
        "{{SubTotal}}": subTotal,
        "{{TaxAmount}}": tax,
        "{{DiscountAmount}}": discount,
        "{{CustomerName}}": text("PartyName"),
        "{{BillAmount}}": amount,
      });
    }
    return map;
  }
}
