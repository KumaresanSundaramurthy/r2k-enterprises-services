import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

const THEMES = "Settings.PrintThemeConfigTbl";
// Global templates, shared by every organisation
const TEMPLATES = "Settings.PrintTemplatesTbl";
const TEMPLATE_LIST_COLUMNS = ["TemplateUID", "TemplateKey", "TemplateName", "Description", "Category", "PreviewImage", "SortOrder", "IsActive", "CreatedOn", "UpdatedOn"];

// CI3 Organisation_model print theme / template queries.
@Injectable()
export class PrintThemesRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getPrintThemeConfigsPaginated — the organisation's themes with their template's name and preview
  async themesPage(orgUID: number, limit: number, offset: number): Promise<{ rows: Row[]; totalCount: number }> {
    const base = () =>
      this.read(`${THEMES} as TC`)
        .leftJoin(`${TEMPLATES} as PT`, (on) => on.on("PT.TemplateUID", "TC.TemplateUID").andOnVal("PT.IsDeleted", "=", 0))
        .where({ "TC.OrgUID": orgUID, "TC.IsDeleted": 0 });
    const [count, rows] = await Promise.all([
      base().count({ total: "*" }).first(),
      base()
        .select("TC.*", "PT.TemplateName as TemplateName", "PT.PreviewImage as TemplatePreviewImage")
        .orderBy("TC.ThemeConfigUID", "asc")
        .limit(limit)
        .offset(offset),
    ]);
    return { rows, totalCount: Number(count?.total ?? 0) };
  }

  // getPrintThemeConfigs — modules that already have a theme
  async themedModules(orgUID: number): Promise<number[]> {
    const rows: Row[] = await this.read(THEMES).select("ModuleUID").where({ OrgUID: orgUID, IsDeleted: 0 }).orderBy("ThemeConfigUID", "asc");
    return rows.map((row) => Number(row.ModuleUID));
  }

  async themeByType(orgUID: number, transactionType: string): Promise<Row | null> {
    const row = await this.read(THEMES).select("ThemeConfigUID").where({ OrgUID: orgUID, TransactionType: transactionType, IsDeleted: 0 }).first();
    return row ?? null;
  }

  // getPrintThemeByType — theme config + template HTML/preview for rendering PDFs
  async themeByTypeWithTemplate(orgUID: number, transactionType: string): Promise<Row | null> {
    const row = await this.read(`${THEMES} as TC`)
      .select("TC.*", "PT.HtmlContent as TemplateHtmlContent", "PT.PreviewImage as TemplatePreviewImage", "PT.TemplateName as TemplateName")
      .leftJoin(`${TEMPLATES} as PT`, (on) => on.on("PT.TemplateUID", "TC.TemplateUID").andOnVal("PT.IsDeleted", "=", 0))
      .where({ "TC.OrgUID": orgUID, "TC.TransactionType": transactionType, "TC.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // getPrintTemplatesPaginated — Search matches the template name
  async templatesPage(limit: number, offset: number, search: string): Promise<{ rows: Row[]; totalCount: number }> {
    const base = () => {
      const qb = this.read(TEMPLATES).where("IsDeleted", 0);
      if (search) qb.where("TemplateName", "like", BaseRepository.likePattern(search));
      return qb;
    };
    const [count, rows] = await Promise.all([
      base().count({ total: "*" }).first(),
      base().select(TEMPLATE_LIST_COLUMNS).orderBy("SortOrder", "asc").limit(limit).offset(offset),
    ]);
    return { rows, totalCount: Number(count?.total ?? 0) };
  }

  // getPrintTemplatesAll — active templates for the theme carousel
  async activeTemplates(): Promise<Row[]> {
    return this.read(TEMPLATES)
      .select("TemplateUID", "TemplateKey", "TemplateName", "Description", "Category", "PreviewImage", "PreviewHtmlContent")
      .where({ IsDeleted: 0, IsActive: 1 })
      .orderBy("SortOrder", "asc");
  }

  // getPrintTemplateByUID — full row with the HTML
  async template(templateUID: number): Promise<Row | null> {
    const row = await this.read(TEMPLATES).select("*").where({ TemplateUID: templateUID, IsDeleted: 0 }).first();
    return row ?? null;
  }

  async insertTheme(data: Row): Promise<void> {
    await this.db.write(THEMES).insert(data);
  }

  async updateTheme(orgUID: number, where: Row, data: Row): Promise<void> {
    await this.db.write(THEMES).where({ ...where, OrgUID: orgUID }).update(data);
  }

  async insertTemplate(data: Row): Promise<void> {
    await this.db.write(TEMPLATES).insert(data);
  }

  async updateTemplate(where: Row, data: Row): Promise<void> {
    await this.db.write(TEMPLATES).where(where).update(data);
  }
}
