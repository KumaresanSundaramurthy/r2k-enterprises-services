import { Injectable } from "@nestjs/common";
import { SessionDataRepository } from "../../auth/repositories/session-data.repository";
import { SessionService } from "../../auth/services/session.service";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postFlag, postInt, postValue } from "../../core/utils/form-values";
import { SessionSyncService } from "../session-sync/session-sync.service";
import { SettingsLookupsRepository } from "./settings-lookups.repository";

type Form = Record<string, unknown>;

const DATE_FORMATS = ["d-m-Y", "d/m/Y", "Y-m-d", "Y/m/d", "d.m.Y", "m/d/Y", "d M Y"];
const DATETIME_FORMATS = ["d-m-Y H:i", "d/m/Y H:i", "Y-m-d H:i", "d M Y H:i", "d-m-Y h:i A", "d/m/Y h:i A", "Y-m-d h:i A", "d M Y h:i A"];
const RETURN_DAYS = [0, 3, 5, 7, 10, 14, 21, 30];

// The posted value when it is one of the allowed ones, otherwise the fallback (CI3's in_array checks)
function oneOf<T>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// A posted number within [min, max], otherwise the fallback
function inRange(value: number, min: number, max: number, fallback: number): number {
  return value < min || value > max ? fallback : value;
}

/**
 * Settings → General Settings (CI3 Settings::generalsettings and its three save actions). Each save also refreshes
 * the matching part of the logged-in session (GenSettings / ProdSettings / TransSettings), as CI3 does.
 */
@Injectable()
export class GeneralSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly lookups: SettingsLookupsRepository,
    private readonly sessionData: SessionDataRepository,
    private readonly sessions: SessionService,
    private readonly sessionSync: SessionSyncService
  ) {}

  // generalsettings — the three setting groups and the product-setting dropdowns
  async getPageData(orgUID: number) {
    const [genSettings, twoStep, prodSettings, transSettings, discTypes, prodTypes, prodTaxes, taxDetails, salutations] = await Promise.all([
      this.sessionData.getOrgGeneralSettings(orgUID),
      this.db.read("Settings.OrgSettingsTbl").select("TwoStepLogin").where({ OrgUID: orgUID }).first(),
      this.sessionData.getProductSettings(orgUID),
      this.sessions.loadTransactionSettings(orgUID),
      this.lookups.discountTypes(),
      this.lookups.productTypes(),
      this.lookups.productTaxes(),
      this.lookups.taxDetails(),
      this.lookups.salutations(),
    ]);
    return {
      // TwoStepLogin is not in the session's GenSettings; without it the page would always show (and save) it off
      GenSettings: { ...(genSettings ?? {}), TwoStepLogin: Number(twoStep?.TwoStepLogin ?? 0) },
      ProdSettings: prodSettings ?? {},
      TransSettings: transSettings,
      DiscTypeInfo: discTypes,
      ProdTypeInfo: prodTypes,
      ProdTaxInfo: prodTaxes,
      TaxDetInfo: taxDetails,
      SalutationList: salutations,
    };
  }

  // getSalutationList
  async getSalutations() {
    return { Data: await this.lookups.salutations() };
  }

  // updateGeneralSettings — every value is checked against its allowed set and falls back to the CI3 default
  async updateGeneral(form: Form, ctx: WriteContext, sessionKey: string | undefined) {
    const currency = [...String(postValue(form, "CurrenySymbol") ?? "₹").trim()][0] ?? "";
    if (!currency) throw new CiValidationError("Currency symbol is required (1 character).");

    const enableStorage = postFlag(form, "EnableStorage");
    const showStats = postFlag(form, "ShowStats");
    const enableAI = postFlag(form, "EnableAIAssistant") ? "Yes" : "No";
    let empCodePrefix = String(postValue(form, "EmpCodePrefix") ?? "EMP").trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(empCodePrefix)) empCodePrefix = "EMP";

    const data = {
      CurrenySymbol: currency,
      SerialNoDisplay: postFlag(form, "SerialNoDisplay"),
      FYStartMonth: inRange(postInt(form, "FYStartMonth"), 1, 12, 4),
      RowLimit: oneOf(postInt(form, "RowLimit"), [10, 25, 50, 100], 10),
      QtyMaxLength: inRange(postInt(form, "QtyMaxLength"), 1, 15, 6),
      EnableStorage: enableStorage,
      MandatoryStorage: enableStorage ? postFlag(form, "MandatoryStorage") : 0,
      MaxShippingAddr: inRange(postInt(form, "MaxShippingAddr"), 1, 5, 3),
      FormDateFormat: oneOf(postValue(form, "FormDateFormat"), DATE_FORMATS, "d-m-Y"),
      ListDateFormat: oneOf(postValue(form, "ListDateFormat"), DATE_FORMATS, "d-m-Y"),
      PrintDateFormat: oneOf(postValue(form, "PrintDateFormat"), DATE_FORMATS, "d-m-Y"),
      FormDateTimeFormat: oneOf(postValue(form, "FormDateTimeFormat"), DATETIME_FORMATS, "d-m-Y H:i"),
      ListDateTimeFormat: oneOf(postValue(form, "ListDateTimeFormat"), DATETIME_FORMATS, "d-m-Y H:i"),
      PrintDateTimeFormat: oneOf(postValue(form, "PrintDateTimeFormat"), DATETIME_FORMATS, "d-m-Y H:i"),
      DefaultSalutationUID: postInt(form, "DefaultSalutationUID") || null,
      ShowStats: showStats,
      StatsDefaultOpen: showStats ? postFlag(form, "StatsDefaultOpen") : 0,
      EnableAIAssistant: enableAI,
      TwoStepLogin: postFlag(form, "TwoStepLogin"),
      EmpCodePrefix: empCodePrefix,
      EmpCodeSeparator: oneOf(postValue(form, "EmpCodeSeparator") ?? "-", ["-", "/", "none"], "-"),
      EmpCodeDigits: oneOf(postInt(form, "EmpCodeDigits"), [3, 4, 5, 6], 4),
    };
    await this.db.write("Settings.OrgSettingsTbl").where({ OrgUID: ctx.orgUID }).update(data);

    const fresh = await this.sessionData.getOrgGeneralSettings(ctx.orgUID);
    await this.sessionSync.patch(sessionKey, (session) => ({ ...session, GenSettings: { ...(fresh ?? (session.GenSettings as object)), EnableAIAssistant: enableAI } }));
    return { Message: "Settings saved successfully." };
  }

  // updateProductSettings — the four product-form defaults
  async updateProduct(form: Form, ctx: WriteContext, sessionKey: string | undefined) {
    const values = {
      DefaultProductTypeUID: postInt(form, "DefaultProductTypeUID"),
      DefaultDiscountTypeUID: postInt(form, "DefaultDiscountTypeUID"),
      DefaultProductTaxUID: postInt(form, "DefaultProductTaxUID"),
      DefaultTaxDetailUID: postInt(form, "DefaultTaxDetailUID"),
    };
    if (values.DefaultProductTypeUID <= 0) throw new CiValidationError("Please select a default product type.");
    if (values.DefaultDiscountTypeUID <= 0) throw new CiValidationError("Please select a default discount type.");
    if (values.DefaultProductTaxUID <= 0) throw new CiValidationError("Please select a default product tax.");
    if (values.DefaultTaxDetailUID <= 0) throw new CiValidationError("Please select a default tax percentage.");

    await this.db
      .write("Settings.OrgProductSettingsTbl")
      .insert({ OrgUID: ctx.orgUID, ...values, UpdatedBy: ctx.userUID })
      .onConflict()
      .merge([...Object.keys(values), "UpdatedBy"]);

    const fresh = await this.sessionData.getProductSettings(ctx.orgUID);
    if (fresh) await this.sessionSync.patch(sessionKey, (session) => ({ ...session, ProdSettings: fresh }));
    return { Message: "Product settings saved successfully." };
  }

  // updateTransactionSettings — upsert of the transaction-form options
  async updateTransaction(form: Form, ctx: WriteContext, sessionKey: string | undefined) {
    const values = {
      InvoiceCancelAction: oneOf(postValue(form, "InvoiceCancelAction"), ["ask", "credit_note", "refund", "cancel_only"], "ask"),
      SalesReturnCancelAction: oneOf(postValue(form, "SalesReturnCancelAction"), ["ask", "recover", "writeoff"], "ask"),
      SalesReturnItemMethod: oneOf(postValue(form, "SalesReturnItemMethod"), ["Manual", "Automatic", "Both"], "Manual"),
      TermsAndConditions: String(form.TermsAndConditions ?? "").trim(),
      HideNavOnTransForm: postFlag(form, "HideNavOnTransForm"),
      PurchaseShowSignature: postFlag(form, "PurchaseShowSignature"),
      PurchaseShowTerms: postFlag(form, "PurchaseShowTerms"),
      PurchaseReturnCancelAction: oneOf(postValue(form, "PurchaseReturnCancelAction"), ["ask", "recover", "writeoff"], "ask"),
      PurchaseReturnItemMethod: oneOf(postValue(form, "PurchaseReturnItemMethod"), ["Manual", "Automatic", "Both"], "Manual"),
      ShowProductDescription: postFlag(form, "ShowProductDescription"),
      DCDefaultReturnDays: oneOf(postInt(form, "DCDefaultReturnDays"), RETURN_DAYS, 7),
      QuotValidityDays: inRange(postInt(form, "QuotValidityDays"), 1, 365, 7),
      ShowTransactionStats: postFlag(form, "ShowTransactionStats"),
      ComboPriceDistribution: oneOf(postValue(form, "ComboPriceDistribution"), ["ratio", "average"], "ratio"),
      BelowPurchasePriceAction: oneOf(postValue(form, "BelowPurchasePriceAction"), ["warn", "strict"], "warn"),
      DefaultTransactionType: oneOf(postValue(form, "DefaultTransactionType"), ["regular", "without_tax"], "regular"),
      AutoDraftSave: postFlag(form, "AutoDraftSave"),
      AutoUpdatePurchasePrice: oneOf(postValue(form, "AutoUpdatePurchasePrice"), ["off", "auto", "manual"], "off"),
      PurchaseCancelAction: oneOf(postValue(form, "PurchaseCancelAction"), ["ask", "debit_note", "refund"], "ask"),
    };
    await this.db
      .write("Settings.TransactionSettingsTbl")
      .insert({ OrgUID: ctx.orgUID, ...values, UpdatedBy: ctx.userUID })
      .onConflict()
      .merge([...Object.keys(values), "UpdatedBy"]);

    const fresh = await this.sessions.loadTransactionSettings(ctx.orgUID);
    await this.sessionSync.patch(sessionKey, (session) => ({ ...session, TransSettings: fresh }));
    return { Message: "Transaction settings saved successfully." };
  }
}

