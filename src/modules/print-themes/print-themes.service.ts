import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postFlag, postInt, postValue } from "../../core/utils/form-values";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { SettingsLookupsRepository } from "../settings/settings-lookups.repository";
import { PrintThemesRepository } from "./print-themes.repository";

type Form = Record<string, unknown>;

const TEMPLATE_CATEGORIES = ["general", "gst", "minimal", "formal", "modern"];
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

const text = (form: Form, key: string): string => String(postValue(form, key) ?? "").trim();

/**
 * Settings → Print Templates (CI3 Printthemes): the organisation's theme per transaction type, and the global
 * print templates the themes are built on.
 */
@Injectable()
export class PrintThemesService {
  constructor(
    private readonly repo: PrintThemesRepository,
    private readonly lookups: SettingsLookupsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly orgInfoCache: OrgInfoCacheService
  ) {}

  // _loadPrintModules — { Name: DisplayName } and { Name: ModuleUID } of the modules that print
  private async printModules() {
    const types: Record<string, string> = {};
    const ids: Record<string, number> = {};
    for (const row of await this.lookups.modulesWith("IsPrintTemplate")) {
      types[String(row.Name)] = String(row.DisplayName);
      ids[String(row.Name)] = Number(row.ModuleUID);
    }
    return { types, ids };
  }

  // index — transaction types, templates for the carousel, modules already themed and the org preview header
  async getPageData(orgUID: number) {
    const [modules, templates, usedTypes, preview] = await Promise.all([
      this.printModules(),
      this.repo.activeTemplates(),
      this.repo.themedModules(orgUID),
      this.orgInfoCache.get(orgUID),
    ]);
    return { TransactionTypes: modules.types, TransactionTypeIds: modules.ids, Templates: templates, UsedTypes: usedTypes, OrgPreviewData: preview };
  }

  // getThemeList — the CI3 JS builds the rows
  async getThemes(orgUID: number, pageNo: number, rowLimit?: number) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const [page, modules] = await Promise.all([this.repo.themesPage(orgUID, limit, (pageNo - 1) * limit), this.printModules()]);
    return { Data: page.rows, TotalCount: page.totalCount, PageNo: pageNo, RowLimit: limit, TransactionTypes: modules.types };
  }

  // getTemplateList
  async getTemplates(orgUID: number, pageNo: number, rowLimit: number | undefined, search: string) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = await this.repo.templatesPage(limit, (pageNo - 1) * limit, search.trim());
    return { Data: page.rows, TotalCount: page.totalCount, PageNo: pageNo, RowLimit: limit };
  }

  // getThemeData
  async getTheme(orgUID: number, themeConfigUID: number) {
    const page = await this.repo.themesPage(orgUID, 200, 0);
    const theme = page.rows.find((row) => Number(row.ThemeConfigUID) === themeConfigUID);
    if (!theme) throw new CiValidationError("Theme config not found.");
    return { Data: theme };
  }

  // getTemplateData
  async getTemplate(templateUID: number) {
    const template = await this.repo.template(templateUID);
    if (!template) throw new CiValidationError("Template not found.");
    return { Data: template };
  }

  // saveTheme — one theme per transaction type; colours, font and the template's key are checked
  async saveTheme(form: Form, ctx: WriteContext) {
    const themeConfigUID = postInt(form, "ThemeConfigUID");
    const transactionType = text(form, "TransactionType");
    const templateUID = postInt(form, "TemplateUID");
    const modules = await this.printModules();
    if (!(transactionType in modules.types)) throw new CiValidationError("Invalid transaction type.");

    const primary = text(form, "PrimaryColor") || "#1a3c6e";
    const accent = text(form, "AccentColor") || "#f59e0b";
    let font = text(form, "FontFamily") || "Arial";
    if (!/^[a-zA-Z0-9 -]+$/.test(font)) font = "Arial";
    let themeKey = "classic";
    if (templateUID > 0) {
      const template = await this.repo.template(templateUID);
      if (template) themeKey = String(template.TemplateKey);
    } else {
      themeKey = text(form, "ThemeKey") || "classic";
    }
    const flag = (key: string) => postFlag(form, key);
    const data = {
      TransactionType: transactionType,
      ModuleUID: modules.ids[transactionType] ?? 0,
      TemplateUID: templateUID,
      ThemeKey: themeKey.slice(0, 50),
      PrimaryColor: HEX_COLOUR.test(primary) ? primary : "#1a3c6e",
      AccentColor: HEX_COLOUR.test(accent) ? accent : "#f59e0b",
      ShowLogo: flag("ShowLogo"),
      ShowOrgAddress: flag("ShowOrgAddress"),
      ShowGSTIN: flag("ShowGSTIN"),
      ShowHSN: flag("ShowHSN"),
      ShowTaxBreakdown: flag("ShowTaxBreakdown"),
      ShowPartyBalance: flag("ShowPartyBalance"),
      ShowTime: flag("ShowTime"),
      FontFamily: font.slice(0, 100),
      FontSizePx: Math.max(8, Math.min(20, postInt(form, "FontSizePx") || 11)),
      UpdatedBy: ctx.userUID,
    };

    if (themeConfigUID > 0) {
      await this.repo.updateTheme(ctx.orgUID, { ThemeConfigUID: themeConfigUID, IsDeleted: 0 }, data);
    } else {
      if (await this.repo.themeByType(ctx.orgUID, transactionType)) {
        throw new CiValidationError(`${modules.types[transactionType]} already has a theme configured. Edit it instead.`);
      }
      await this.repo.insertTheme({ ...data, OrgUID: ctx.orgUID, CreatedBy: ctx.userUID, IsActive: 1, IsDeleted: 0 });
    }
    return { Message: "Theme saved successfully." };
  }

  // deleteTheme
  async deleteTheme(themeConfigUID: number, ctx: WriteContext) {
    if (themeConfigUID <= 0) throw new CiValidationError("Invalid theme config.");
    await this.repo.updateTheme(ctx.orgUID, { ThemeConfigUID: themeConfigUID }, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    return { Message: "Theme removed." };
  }

  // saveTemplate — a global template; its key is built from the name when empty
  async saveTemplate(form: Form) {
    const templateUID = postInt(form, "TemplateUID");
    const name = text(form, "TemplateName");
    if (!name) throw new CiValidationError("Template name is required.");
    const key = (text(form, "TemplateKey") || name).toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
    if (!key) throw new CiValidationError("Invalid template key.");
    const category = text(form, "Category") || "general";

    const data = {
      TemplateKey: key,
      TemplateName: name,
      Description: text(form, "Description").slice(0, 500),
      Category: TEMPLATE_CATEGORIES.includes(category) ? category : "general",
      HtmlContent: text(form, "HtmlContent"),
      PreviewHtmlContent: text(form, "PreviewHtmlContent"),
      PreviewImage: text(form, "PreviewImage").slice(0, 500),
      SortOrder: Math.max(0, postInt(form, "SortOrder")),
    };
    if (templateUID > 0) await this.repo.updateTemplate({ TemplateUID: templateUID, IsDeleted: 0 }, data);
    else await this.repo.insertTemplate({ ...data, IsActive: 1, IsDeleted: 0 });
    return { Message: "Template saved successfully." };
  }

  // getPrintThemeByType — theme config + template HTML for PDF rendering; called by public Doc/Receipt pages
  async getThemeByType(orgUID: number, transactionType: string) {
    return { Data: await this.repo.themeByTypeWithTemplate(orgUID, transactionType) };
  }

  // deleteTemplate
  async deleteTemplate(templateUID: number) {
    if (templateUID <= 0) throw new CiValidationError("Invalid template.");
    await this.repo.updateTemplate({ TemplateUID: templateUID }, { IsDeleted: 1, IsActive: 0 });
    return { Message: "Template removed." };
  }
}
