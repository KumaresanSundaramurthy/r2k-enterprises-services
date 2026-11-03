import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postFlag, postInt, postValue } from "../../core/utils/form-values";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { MESSAGE_TEMPLATES, PREFIXES, PrintConfigRepository, THERMAL_CONFIGS } from "./print-config.repository";
import { SettingsLookupsRepository } from "./settings-lookups.repository";

type Form = Record<string, unknown>;

// Tokens a message template can use (CI3 Settings::$MSG_TOKENS)
export const MSG_TOKENS: Record<string, string> = {
  "{{PARTY_NAME}}": "Customer / Vendor full name",
  "{{DOC_NUMBER}}": "Document number (e.g. INV-001)",
  "{{DOC_DATE}}": "Document date",
  "{{DOC_TYPE}}": "Document type (Invoice, Quotation…)",
  "{{AMOUNT}}": "Total amount with currency",
  "{{CURRENCY}}": "Currency symbol",
  "{{RECEIPT_NUMBER}}": "Payment receipt number",
  "{{PAYMENT_MODE}}": "Payment mode (Cash, UPI…)",
  "{{PAYMENT_STATUS}}": "Payment status (Paid / Partially Paid)",
  "{{RECEIPT_LINK}}": "Public receipt link URL",
  "{{ORG_NAME}}": "Organisation / Brand name",
  "{{ORG_PHONE}}": "Organisation phone number",
  "{{ORG_EMAIL}}": "Organisation email address",
  "{{ORG_ADDRESS}}": "Organisation address",
  "{{ORG_GSTIN}}": "Organisation GSTIN",
  "{{VALID_UNTIL}}": "Validity / due date",
  "{{BALANCE_AMOUNT}}": "Pending / balance amount",
};

// Payments in / out: their thermal receipts have no item lines (CI3 ModuleUID 110, 111)
const PAYMENT_MODULES = [110, 111];
const PREFIX_SEPARATORS = ["", "-", "/", "|", "_", "."];

const text = (form: Form, key: string): string => String(postValue(form, key) ?? "").trim();
const fontSize = (form: Form, key: string, fallback: number) => Math.max(8, Math.min(40, postInt(form, key) || fallback));

/**
 * Settings → Message Templates, Thermal Print and Prefix Config (CI3 Settings). Lists come back as data
 * (the CI3 views built HTML from the same rows) with the module map each page needs.
 */
@Injectable()
export class PrintConfigService {
  constructor(
    private readonly repo: PrintConfigRepository,
    private readonly lookups: SettingsLookupsRepository,
    private readonly db: DatabaseService,
    private readonly orgInfoCache: OrgInfoCacheService
  ) {}

  // ── Message templates ─────────────────────────────────────────────────

  // msgtemplates / getMsgTemplateList — templates, the module map and the tokens
  async getMessageTemplates(orgUID: number) {
    const [rows, modules] = await Promise.all([this.repo.messageTemplates(orgUID), this.lookups.moduleNames("IsThermalPrint")]);
    return { Data: rows, TotalCount: rows.length, Modules: modules, Tokens: MSG_TOKENS };
  }

  async getMessageTemplate(orgUID: number, templateUID: number) {
    if (templateUID <= 0) throw new CiValidationError("Invalid template.");
    const row = await this.repo.findOne(MESSAGE_TEMPLATES, { TemplateUID: templateUID }, orgUID);
    if (!row) throw new CiValidationError("Template not found.");
    return { Data: row };
  }

  async saveMessageTemplate(form: Form, ctx: WriteContext) {
    const templateUID = postInt(form, "TemplateUID");
    const moduleUID = postInt(form, "ModuleUID");
    const channel = String(postValue(form, "Channel") ?? "");
    const body = text(form, "Body");
    if (!["Email", "WhatsApp", "SMS"].includes(channel)) throw new CiValidationError("Invalid channel.");
    if (!moduleUID) throw new CiValidationError("Please select a transaction type.");
    if (!body) throw new CiValidationError("Template body is required.");

    const data = { ModuleUID: moduleUID, Channel: channel, Subject: text(form, "Subject") || null, Body: body, IsActive: 1, IsDeleted: 0, UpdatedBy: ctx.userUID };
    let message: string;
    if (templateUID > 0) {
      await this.repo.update(MESSAGE_TEMPLATES, { TemplateUID: templateUID, IsDeleted: 0 }, ctx.orgUID, data);
      message = "Template updated.";
    } else {
      await this.repo.insert(MESSAGE_TEMPLATES, { ...data, OrgUID: ctx.orgUID, CreatedBy: ctx.userUID });
      message = "Template saved.";
    }
    return { Message: message, ...(await this.getMessageTemplates(ctx.orgUID)) };
  }

  async deleteMessageTemplate(templateUID: number, ctx: WriteContext) {
    if (templateUID <= 0) throw new CiValidationError("Invalid template.");
    await this.repo.update(MESSAGE_TEMPLATES, { TemplateUID: templateUID }, ctx.orgUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    return { Message: "Template deleted." };
  }

  // ── Thermal print ─────────────────────────────────────────────────────

  // thermalconfig — the list plus the organisation header the receipt preview shows
  async getThermalPageData(orgUID: number) {
    const list = await this.getThermalConfigs(orgUID);
    return { ...list, ThermalTypeCount: Object.keys(list.TransTypes).length, OrgPreviewData: await this.orgInfoCache.get(orgUID) };
  }

  // getThermalConfigList — configs, the modules already configured and the modules that can be
  async getThermalConfigs(orgUID: number) {
    const [rows, transTypes] = await Promise.all([this.repo.thermalConfigs(orgUID), this.lookups.moduleNames("IsThermalPrint")]);
    return { Data: rows, UsedTypes: rows.map((row) => Number(row.ModuleUID)), TotalCount: rows.length, TransTypes: transTypes };
  }

  // saveThermalConfig — one config per module
  async saveThermalConfig(form: Form, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    const configUID = postInt(form, "ThermalConfigUID");
    const moduleUID = postInt(form, "ModuleUID");
    const transTypes = await this.lookups.moduleNames("IsThermalPrint");
    if (!(moduleUID in transTypes)) throw new CiValidationError("Invalid module / transaction type.");
    if (configUID <= 0 && (await this.repo.findOne(THERMAL_CONFIGS, { ModuleUID: moduleUID }, orgUID))) {
      throw new CiValidationError(`A thermal config for "${transTypes[moduleUID]}" already exists. Please edit it instead.`);
    }

    const noItems = PAYMENT_MODULES.includes(moduleUID);
    const flag = (key: string) => postFlag(form, key);
    const itemFlag = (key: string) => (noItems ? 0 : flag(key));
    const paperWidth = String(postValue(form, "PaperWidth") ?? "");
    const data = {
      PaperWidth: ["58mm", "80mm"].includes(paperWidth) ? paperWidth : "80mm",
      FooterMessage: text(form, "FooterMessage").slice(0, 500) || null,
      ShowTerms: flag("ShowTerms"),
      ShowCompanyDetails: flag("ShowCompanyDetails"),
      ShowItemDescription: itemFlag("ShowItemDescription"),
      ShowTaxableAmount: itemFlag("ShowTaxableAmount"),
      ShowHSN: itemFlag("ShowHSN"),
      ShowTaxBreakdown: itemFlag("ShowTaxBreakdown"),
      ShowGSTIN: flag("ShowGSTIN"),
      ShowMobile: flag("ShowMobile"),
      ShowCashReceived: flag("ShowCashReceived"),
      ShowLogo: flag("ShowLogo"),
      ShowGoogleReviewQR: flag("ShowGoogleReviewQR"),
      ShowPaymentQR: flag("ShowPaymentQR"),
      OrgNameFontSize: fontSize(form, "OrgNameFontSize", 16),
      CompanyNameFontSize: fontSize(form, "CompanyNameFontSize", 14),
      ProductInfoFontSize: fontSize(form, "ProductInfoFontSize", 12),
      UpdatedBy: userUID,
    };

    let message: string;
    if (configUID > 0) {
      await this.repo.update(THERMAL_CONFIGS, { ThermalConfigUID: configUID, IsDeleted: 0 }, orgUID, data);
      message = "Thermal print config updated.";
    } else {
      await this.repo.insert(THERMAL_CONFIGS, {
        ...data,
        OrgUID: orgUID,
        ModuleUID: moduleUID,
        TransactionType: transTypes[moduleUID] ?? "Unknown",
        CreatedBy: userUID,
        IsActive: 1,
        IsDeleted: 0,
      });
      message = "Thermal print config saved.";
    }
    return { Message: message, ...(await this.getThermalConfigs(orgUID)) };
  }

  async deleteThermalConfig(configUID: number, ctx: WriteContext) {
    if (configUID <= 0) throw new CiValidationError("Invalid config ID.");
    await this.repo.update(THERMAL_CONFIGS, { ThermalConfigUID: configUID }, ctx.orgUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    return { Message: "Thermal print config deleted." };
  }

  // ── Prefix configuration ─────────────────────────────────────────────

  // prefixconfig / getPrefixConfigList
  async getPrefixes(orgUID: number) {
    const [rows, modules] = await Promise.all([this.repo.prefixes(orgUID), this.lookups.moduleNames("IsPrefix")]);
    return { Data: rows, TotalCount: rows.length, Modules: modules, PrefixModuleCount: Object.keys(modules).length };
  }

  // savePrefixConfig — one default per module; the first prefix of a module is always its default
  async savePrefix(form: Form, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    const prefixUID = postInt(form, "prePrefixUID");
    let moduleUID = postInt(form, "preModuleUID");
    const name = text(form, "transPrefixName").toUpperCase();
    if (!name || name.length < 2 || name.length > 7 || !/^[A-Z0-9]+$/.test(name)) throw new CiValidationError("Prefix name must be 2–7 alphanumeric characters.");
    if (prefixUID <= 0 && !moduleUID) throw new CiValidationError("Please select a module.");

    const rawSeparator = postValue(form, "prefixSeparator", "") ?? "";
    const separator = PREFIX_SEPARATORS.includes(String(rawSeparator)) ? String(rawSeparator) : "-";
    const padding = ["1", "3"].includes(String(postValue(form, "numberPadding") ?? "3")) ? Number(postValue(form, "numberPadding") ?? 3) : 3;
    const fiscalFormat = String(postValue(form, "fiscalYearFormat") ?? "");
    const includeShortName = postFlag(form, "includeShortName");
    const shortName = String(postValue(form, "companyShortName") ?? "").slice(0, 20).toUpperCase();
    if (includeShortName && !shortName) throw new CiValidationError("Company short name is required when enabled.");
    const componentConfig = PrintConfigService.jsonObjectOrNull(postValue(form, "componentConfig"));
    let isDefault = postFlag(form, "isDefault");

    const data = {
      Name: name,
      IncludeFiscalYear: postFlag(form, "includeFiscalYear"),
      FiscalYearFormat: ["SHORT", "LONG"].includes(fiscalFormat) ? fiscalFormat : "SHORT",
      IncludeShortName: includeShortName,
      ShortName: includeShortName ? shortName : "",
      Separator: separator,
      NumberPadding: padding,
      ComponentConfig: componentConfig,
      UpdatedBy: userUID,
    };

    let message: string;
    if (prefixUID > 0) {
      const existing = await this.repo.prefix(orgUID, prefixUID);
      if (!existing) throw new CiValidationError("Prefix not found.");
      moduleUID = Number(existing.ModuleUID ?? 0);
      // The only default of a module cannot be unset here
      if (Number(existing.IsDefault) && !isDefault) isDefault = 1;
      await this.db.write.transaction(async (trx) => {
        if (isDefault) await this.clearModuleDefault(orgUID, moduleUID, userUID, trx);
        await this.repo.update(PREFIXES, { PrefixUID: prefixUID, IsDeleted: 0 }, orgUID, { ...data, IsDefault: isDefault }, trx);
      });
      message = "Prefix updated successfully.";
    } else {
      if ((await this.repo.count(PREFIXES, { ModuleUID: moduleUID }, orgUID)) === 0) isDefault = 1;
      await this.db.write.transaction(async (trx) => {
        if (isDefault) await this.clearModuleDefault(orgUID, moduleUID, userUID, trx);
        await this.repo.insert(
          PREFIXES,
          { ...data, OrgUID: orgUID, ModuleUID: moduleUID || null, IsDefault: isDefault, IsActive: 1, IsDeleted: 0, CreatedBy: userUID },
          trx
        );
      });
      message = "Prefix added successfully.";
    }
    return { Message: message, ...(await this.getPrefixes(orgUID)) };
  }

  // deletePrefixConfig — the default prefix is kept
  async deletePrefix(prefixUID: number, ctx: WriteContext) {
    if (prefixUID <= 0) throw new CiValidationError("Invalid prefix ID.");
    const existing = await this.repo.prefix(ctx.orgUID, prefixUID);
    if (!existing) throw new CiValidationError("Prefix not found.");
    if (Number(existing.IsDefault)) throw new CiValidationError("Cannot delete the default prefix. Set another prefix as default first.");
    await this.repo.update(PREFIXES, { PrefixUID: prefixUID }, ctx.orgUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    return { Message: "Prefix deleted successfully." };
  }

  // setDefaultPrefixConfig — the default within the prefix's own module
  async setDefaultPrefix(prefixUID: number, ctx: WriteContext) {
    if (prefixUID <= 0) throw new CiValidationError("Invalid prefix ID.");
    const existing = await this.repo.prefix(ctx.orgUID, prefixUID);
    if (!existing) throw new CiValidationError("Prefix not found.");
    await this.db.write.transaction(async (trx) => {
      await this.clearModuleDefault(ctx.orgUID, Number(existing.ModuleUID ?? 0), ctx.userUID, trx);
      await this.repo.update(PREFIXES, { PrefixUID: prefixUID, IsDeleted: 0 }, ctx.orgUID, { IsDefault: 1, UpdatedBy: ctx.userUID }, trx);
    });
    return { Message: "Default prefix updated." };
  }

  private async clearModuleDefault(orgUID: number, moduleUID: number, userUID: number, trx: Parameters<PrintConfigRepository["update"]>[4]) {
    await this.repo.update(PREFIXES, { ModuleUID: moduleUID, IsDeleted: 0 }, orgUID, { IsDefault: 0, UpdatedBy: userUID }, trx);
  }

  // componentConfig is stored as posted when it is a JSON array/object, otherwise null
  private static jsonObjectOrNull(value: unknown): string | null {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "object") return JSON.stringify(value);
    try {
      const parsed = JSON.parse(String(value));
      return parsed && typeof parsed === "object" ? String(value) : null;
    } catch {
      return null;
    }
  }
}
