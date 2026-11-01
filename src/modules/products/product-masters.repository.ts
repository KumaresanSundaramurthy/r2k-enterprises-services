import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { resolveCdnUrl, toInt } from "../../common/utils/php-compat";
import { CategoryListFilterDto, SizeListFilterDto } from "./dto/product-list.dto";
import { Row } from "./products.repository";

export type AttachmentEntity = "Product" | "Category" | "Brand";

// One translated name + description row (CategoryTbl_Lang, BrandTbl_Lang, SizeTbl_Lang)
interface LangTable {
  table: string;
  key: string;
  nameColumn: string;
}
export const CATEGORY_LANG: LangTable = { table: "Products.CategoryTbl_Lang", key: "CategoryUID", nameColumn: "Name" };
export const BRAND_LANG: LangTable = { table: "Products.BrandTbl_Lang", key: "BrandUID", nameColumn: "BrandName" };
export const SIZE_LANG: LangTable = { table: "Products.SizeTbl_Lang", key: "SizeUID", nameColumn: "Name" };

const SIZE_COLUMNS = ["SizeCode", "Length", "Width", "Height", "Depth", "Diameter", "Thickness", "Weight", "DimensionUOM", "WeightUOM"];

/**
 * Categories, brands and sizes, their image attachments, and the global lookup lists of the product form
 * (CI3 Products_model category / brand / size / attachment sections and Global_model lookups).
 */
@Injectable()
export class ProductMastersRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // ── Categories ────────────────────────────────────────────────────────────

  // getCategoryListPaginated — active categories with their product count and image gallery
  async listCategories(orgUID: number, pageNo: number, limit: number, filter: CategoryListFilterDto, langCode: string) {
    const base = (query: Knex.QueryBuilder) => this.applyNamedFilters(query, "Category", ["Category.Name", "Category.Description"], filter, orgUID, "CategoryUID");
    const countRow = await base(this.read("Products.CategoryTbl as Category").count({ cnt: "Category.CategoryUID" }).where({ "Category.IsActive": 1 })).first();

    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.CategoryTbl as Category")
      .select(
        "Category.CategoryUID as CategoryUID",
        this.langColumn(useLang, "CL.Name", "Category.Name", "Name"),
        this.langColumn(useLang, "CL.Description", "Category.Description", "Description"),
        "Category.UpdatedOn as UpdatedOn",
        this.read.raw("CONCAT(??, ' ', ??) AS ??", ["User.FirstName", "User.LastName", "UpdatedBy"]),
        this.read.raw("COUNT(CASE WHEN ?? = 0 AND ?? = 1 THEN 1 END) AS ??", ["Products.IsDeleted", "Products.IsActive", "ProductCount"])
      )
      .leftJoin("Users.UserTbl as User", "User.UserUID", "Category.UpdatedBy")
      .leftJoin("Products.ProductTbl as Products", "Products.CategoryUID", "Category.CategoryUID")
      .where({ "Category.IsActive": 1 })
      .groupBy("Category.CategoryUID")
      .limit(limit)
      .offset(BaseRepository.offset(pageNo, limit));
    if (useLang) {
      query.leftJoin("Products.CategoryTbl_Lang as CL", (on) => {
        on.on("CL.CategoryUID", "Category.CategoryUID").andOnVal("CL.LangCode", "=", langCode);
      });
    }
    base(query);
    this.applyNameSort(query, "Category.Name", filter.NameSorting, "Category.CategoryUID");
    const rows: Row[] = await query;
    await this.attachGalleries("Category", rows, "CategoryUID");
    return { rows, totalCount: toInt(countRow?.cnt) };
  }

  // getCategoriesDetails — active categories of the organisation (one, or all)
  async findCategories(orgUID: number, langCode: string, categoryUID = 0): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.CategoryTbl as Category")
      .select(
        "Category.CategoryUID as CategoryUID",
        "Category.OrgUID as OrgUID",
        this.langColumn(useLang, "CL.Name", "Category.Name", "Name"),
        this.langColumn(useLang, "CL.Description", "Category.Description", "Description"),
        "Category.CreatedOn as CreatedOn",
        "Category.UpdatedOn as UpdatedOn"
      )
      .where({ "Category.OrgUID": orgUID, "Category.IsDeleted": 0, "Category.IsActive": 1 })
      .orderBy("Category.CategoryUID", "asc");
    if (categoryUID > 0) query.where("Category.CategoryUID", categoryUID);
    if (useLang) {
      query.leftJoin("Products.CategoryTbl_Lang as CL", (on) => {
        on.on("CL.CategoryUID", "Category.CategoryUID").andOnVal("CL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  async insertCategory(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number> {
    const [categoryUID] = await trx("Products.CategoryTbl").insert(row);
    return categoryUID;
  }

  async updateCategories(orgUID: number, categoryUIDs: number[], data: Record<string, unknown>, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)("Products.CategoryTbl").where({ OrgUID: orgUID }).whereIn("CategoryUID", categoryUIDs).update(data);
  }

  // ── Brands ────────────────────────────────────────────────────────────────

  // getBrandListPaginated — active brands with the number of products using them and their image gallery
  async listBrands(orgUID: number, pageNo: number, limit: number, filter: CategoryListFilterDto, langCode: string) {
    const base = (query: Knex.QueryBuilder) =>
      this.applyNamedFilters(query, "Brand", ["Brand.BrandName", "Brand.BrandCode", "Brand.Description"], filter, orgUID, "BrandUID");
    const countRow = await base(this.read("Products.BrandTbl as Brand").count({ cnt: "Brand.BrandUID" }).where({ "Brand.IsActive": 1 })).first();

    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.BrandTbl as Brand")
      .select(
        "Brand.BrandUID as BrandUID",
        this.langColumn(useLang, "BL.BrandName", "Brand.BrandName", "BrandName"),
        "Brand.BrandCode as BrandCode",
        this.langColumn(useLang, "BL.Description", "Brand.Description", "Description"),
        "Brand.UpdatedOn as UpdatedOn",
        this.read.raw("CONCAT(??, ' ', ??) AS ??", ["User.FirstName", "User.LastName", "UpdatedBy"]),
        this.read.raw(
          "(SELECT COUNT(DISTINCT pv.ProductUID) FROM Products.ProductVariantTbl pv WHERE pv.BrandUID = Brand.BrandUID AND pv.OrgUID = Brand.OrgUID AND pv.IsActive = 1) AS ProductCount"
        )
      )
      .leftJoin("Users.UserTbl as User", "User.UserUID", "Brand.UpdatedBy")
      .where({ "Brand.IsActive": 1 })
      .limit(limit)
      .offset(BaseRepository.offset(pageNo, limit));
    if (useLang) {
      query.leftJoin("Products.BrandTbl_Lang as BL", (on) => {
        on.on("BL.BrandUID", "Brand.BrandUID").andOnVal("BL.LangCode", "=", langCode);
      });
    }
    base(query);
    this.applyNameSort(query, "Brand.BrandName", filter.NameSorting, "Brand.BrandUID");
    const rows: Row[] = await query;
    await this.attachGalleries("Brand", rows, "BrandUID");
    return { rows, totalCount: toInt(countRow?.cnt) };
  }

  // getBrandsForCache (all) / getBrandByUID (one) — active brands of the organisation
  async findBrands(orgUID: number, brandUID = 0): Promise<Row[]> {
    const query = this.read("Products.BrandTbl")
      .select("BrandUID", "BrandName", "BrandCode", "Description")
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("BrandUID", "asc");
    if (brandUID > 0) query.where({ BrandUID: brandUID });
    else query.where({ IsActive: 1 });
    return query;
  }

  // isDuplicateBrandName — case-insensitive, among active brands
  async isDuplicateBrandName(orgUID: number, name: string, excludeUID = 0): Promise<boolean> {
    const query = this.read("Products.BrandTbl")
      .select("BrandUID")
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .whereRaw("LOWER(??) = ?", ["BrandName", name.trim().toLowerCase()]);
    if (excludeUID > 0) query.whereNot({ BrandUID: excludeUID });
    return !!(await query.first());
  }

  // getInUseBrandUIDs / isBrandInUse — brands on active variants or on transaction lines
  async brandsInUse(orgUID: number, brandUIDs: number[]): Promise<number[]> {
    if (brandUIDs.length === 0) return [];
    const [variants, lines] = await Promise.all([
      this.read("Products.ProductVariantTbl").distinct("BrandUID").where({ OrgUID: orgUID, IsActive: 1 }).whereIn("BrandUID", brandUIDs),
      this.read("Transaction.TransProductsTbl").distinct("BrandUID").where({ OrgUID: orgUID, IsDeleted: 0 }).whereIn("BrandUID", brandUIDs),
    ]);
    return [...new Set([...variants, ...lines].map((row: { BrandUID: string }) => toInt(row.BrandUID)))];
  }

  async insertBrand(row: Record<string, unknown>): Promise<number> {
    const [brandUID] = await this.writer()("Products.BrandTbl").insert(row);
    return brandUID;
  }

  async updateBrands(orgUID: number, brandUIDs: number[], data: Record<string, unknown>): Promise<number> {
    return this.writer()("Products.BrandTbl").where({ OrgUID: orgUID }).whereIn("BrandUID", brandUIDs).update(data);
  }

  // ── Sizes ─────────────────────────────────────────────────────────────────

  // getSizeListPaginated — active sizes with the number of products using them
  async listSizes(orgUID: number, pageNo: number, limit: number, filter: SizeListFilterDto, langCode: string) {
    const base = (query: Knex.QueryBuilder) => {
      query.where({ "Size.OrgUID": orgUID, "Size.IsActive": 1 });
      if (filter.SearchAllData !== undefined) query.where("Size.Name", "like", BaseRepository.likePattern(filter.SearchAllData));
      this.applyUpdatedBy(query, "Size", filter.LastUpdatedFilter);
      return query;
    };
    const countRow = await base(this.read("Products.SizeTbl as Size").count({ cnt: "Size.SizeUID" })).first();

    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.SizeTbl as Size")
      .select(
        "Size.SizeUID as SizeUID",
        this.langColumn(useLang, "SZ.Name", "Size.Name", "SizeName"),
        ...SIZE_COLUMNS.map((column) => `Size.${column} as ${column}`),
        this.langColumn(useLang, "SZ.Description", "Size.Description", "Description"),
        "Size.UpdatedOn as UpdatedOn",
        this.read.raw("CONCAT(COALESCE(??, ''), ' ', COALESCE(??, '')) AS ??", ["User.FirstName", "User.LastName", "UpdatedBy"]),
        this.read.raw(
          "(SELECT COUNT(DISTINCT pv.ProductUID) FROM Products.ProductVariantTbl pv WHERE pv.SizeUID = Size.SizeUID AND pv.OrgUID = Size.OrgUID AND pv.IsActive = 1) AS ProductCount"
        )
      )
      .leftJoin("Users.UserTbl as User", "User.UserUID", "Size.UpdatedBy")
      .limit(limit)
      .offset(BaseRepository.offset(pageNo, limit));
    if (useLang) {
      query.leftJoin("Products.SizeTbl_Lang as SZ", (on) => {
        on.on("SZ.SizeUID", "Size.SizeUID").andOnVal("SZ.LangCode", "=", langCode);
      });
    }
    base(query);
    this.applyNameSort(query, "Size.Name", filter.NameSorting, "Size.SizeUID");
    return { rows: (await query) as Row[], totalCount: toInt(countRow?.cnt) };
  }

  // getOrgSizes (slim) / getSizesForCache (full) — active sizes by name
  async findSizes(orgUID: number, full = false): Promise<Row[]> {
    const columns = full ? ["SizeUID", "Name as SizeName", ...SIZE_COLUMNS, "Description"] : ["SizeUID", "Name as SizeName"];
    return this.read("Products.SizeTbl").select(columns).where({ OrgUID: orgUID, IsActive: 1 }).orderBy("Name", "asc");
  }

  // isDuplicateSizeName — exact name among active sizes
  async isDuplicateSizeName(orgUID: number, name: string, excludeUID = 0): Promise<boolean> {
    const query = this.read("Products.SizeTbl").select("SizeUID").where({ OrgUID: orgUID, Name: name, IsActive: 1 });
    if (excludeUID > 0) query.whereNot({ SizeUID: excludeUID });
    return !!(await query.first());
  }

  // getInUseSizeUIDs / isSizeInUse — sizes on active variants
  async sizesInUse(orgUID: number, sizeUIDs: number[]): Promise<number[]> {
    if (sizeUIDs.length === 0) return [];
    const rows: { SizeUID: string }[] = await this.read("Products.ProductVariantTbl").distinct("SizeUID").where({ OrgUID: orgUID, IsActive: 1 }).whereIn("SizeUID", sizeUIDs);
    return rows.map((row) => toInt(row.SizeUID));
  }

  async insertSize(row: Record<string, unknown>): Promise<number> {
    const [sizeUID] = await this.writer()("Products.SizeTbl").insert(row);
    return sizeUID;
  }

  // addSize (inline) — the existing size of that name, or a new one; returns its SizeUID
  async upsertSizeByName(orgUID: number, name: string): Promise<number> {
    // Same connection for the insert and LAST_INSERT_ID()
    return this.db.write.transaction(async (trx) => {
      await trx.raw("INSERT INTO Products.SizeTbl (OrgUID, Name) VALUES (?, ?) ON DUPLICATE KEY UPDATE SizeUID = LAST_INSERT_ID(SizeUID)", [orgUID, name]);
      const result = await trx.raw("SELECT LAST_INSERT_ID() AS id");
      return toInt(result[0][0]?.id);
    });
  }

  async updateSizes(orgUID: number, sizeUIDs: number[], data: Record<string, unknown>): Promise<number> {
    return this.writer()("Products.SizeTbl").where({ OrgUID: orgUID }).whereIn("SizeUID", sizeUIDs).update(data);
  }

  // saveCatgLangRow / saveBrandLangRow / saveSizeLangRow
  async saveLangRow(table: LangTable, uid: number, langCode: string, name: string | null, description: string | null, userUID: number): Promise<void> {
    await this.writer()(table.table)
      .insert({ [table.key]: uid, LangCode: langCode, [table.nameColumn]: name, Description: description, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict([table.key, "LangCode"])
      .merge([table.nameColumn, "Description", "UpdatedBy"]);
  }

  // ── Attachments (Products.EntityAttachmentsTbl) ───────────────────────────

  // getEntityAttachments — with each file's CDN Url
  async findAttachments(orgUID: number, entityType: AttachmentEntity, entityUID: number): Promise<Row[]> {
    const rows: Row[] = await this.read("Products.EntityAttachmentsTbl")
      .select("AttachUID", "FileName", "FilePath", "FileSize", "SortOrder", "CreatedOn")
      .where({ EntityType: entityType, EntityUID: entityUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("SortOrder", "asc");
    return rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath) }));
  }

  // getEntityAttachmentSortStats
  async attachmentStats(orgUID: number, entityType: AttachmentEntity, entityUID: number) {
    const row = await this.read("Products.EntityAttachmentsTbl")
      .select(
        this.read.raw("COALESCE(MAX(??), 0) AS ??", ["SortOrder", "maxSort"]),
        this.read.raw("COUNT(*) AS ??", ["count"]),
        this.read.raw("COALESCE(SUM(??), 0) AS ??", ["FileSize", "totalSize"])
      )
      .where({ EntityType: entityType, EntityUID: entityUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return { maxSort: toInt(row?.maxSort), count: toInt(row?.count), totalSize: Number(row?.totalSize ?? 0) };
  }

  async insertAttachment(row: Record<string, unknown>): Promise<number> {
    const [attachUID] = await this.writer()("Products.EntityAttachmentsTbl").insert(row);
    return attachUID;
  }

  // Soft-deletes attachments of the organisation (entityUID 0 = any entity, as CI3 deleteAttachment)
  async softDeleteAttachments(orgUID: number, attachUIDs: number[], userUID: number, entity?: { type: AttachmentEntity; uid: number }): Promise<number> {
    if (attachUIDs.length === 0) return 0;
    const query = this.writer()("Products.EntityAttachmentsTbl").whereIn("AttachUID", attachUIDs).where({ OrgUID: orgUID, IsDeleted: 0 });
    if (entity && entity.uid > 0) query.where({ EntityType: entity.type, EntityUID: entity.uid });
    return query.update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID });
  }

  // ── Global lookups of the product form (getDropdownCache) ─────────────────

  async lookup(field: string): Promise<Row[] | null> {
    const active = { IsDeleted: 0, IsActive: 1 };
    switch (field) {
      case "primaryUnit":
        return this.read("Global.PrimaryUnitTbl").select("PrimaryUnitUID", "Name", "ShortName", "Description", "UpdatedOn").where(active).orderBy("Sorting", "asc");
      case "discType":
        return this.read("Global.DiscountTypeTbl").select("DiscountTypeUID", "Name", "DisplayName", "Symbol", "UpdatedOn").where(active).orderBy("Sorting", "asc");
      case "prodType":
        return this.read("Global.ProductTypeTbl").select("ProductTypeUID", "Name", "UpdatedOn").where(active).orderBy("Sorting", "asc");
      case "prodTax":
        return this.read("Global.ProductTaxTbl").select("ProductTaxUID", "Name", "UpdatedOn").where(active).orderBy("Sorting", "asc");
      case "taxDetails":
        return this.read("Global.TaxDetailsTbl").select("TaxDetailsUID", "TaxName", "Percentage", "CGST", "SGST", "IGST", "UpdatedOn").where(active).orderBy("Sorting", "asc");
      default:
        return null;
    }
  }

  // Search / product / updated-by filters shared by the category and brand lists
  private applyNamedFilters(query: Knex.QueryBuilder, alias: string, searchColumns: string[], filter: CategoryListFilterDto, orgUID: number, key: string) {
    query.where({ [`${alias}.IsDeleted`]: 0, [`${alias}.OrgUID`]: orgUID });
    if (filter.SearchAllData !== undefined) this.whereAnyLike(query, searchColumns, filter.SearchAllData);
    const productUIDs = (filter.ProductFilter ?? []).filter((uid) => uid > 0);
    if (productUIDs.length > 0) {
      query.whereIn(`${alias}.${key}`, (sub) => {
        if (key === "CategoryUID") {
          sub.select("fp.CategoryUID").from("Products.ProductTbl as fp").where("fp.IsDeleted", 0).whereIn("fp.ProductUID", productUIDs);
        } else {
          // Brands of those products' variants (ProductTbl has no BrandUID; CI3's query failed on it)
          sub.select("fv.BrandUID").from("Products.ProductVariantTbl as fv").where("fv.IsActive", 1).whereIn("fv.ProductUID", productUIDs);
        }
      });
    }
    this.applyUpdatedBy(query, alias, filter.LastUpdatedFilter);
    return query;
  }

  private applyUpdatedBy(query: Knex.QueryBuilder, alias: string, userUIDs: number[] | undefined) {
    const uids = (userUIDs ?? []).filter((uid) => uid > 0);
    if (uids.length > 0) query.whereIn(`${alias}.UpdatedBy`, uids);
  }

  private applyNameSort(query: Knex.QueryBuilder, nameColumn: string, sorting: number | undefined, defaultColumn: string) {
    if (sorting !== undefined) query.orderBy(nameColumn, Number(sorting) === 1 ? "asc" : "desc");
    else query.orderBy(defaultColumn, "desc");
  }

  // Each row's images as AttachmentsJson [{ url, name }] (CDN URLs), one query for the page (products, categories, brands)
  async attachGalleries(entityType: AttachmentEntity, rows: Row[], key: string): Promise<void> {
    if (rows.length === 0) return;
    const attachments: { EntityUID: string; FilePath: string; FileName: string }[] = await this.read("Products.EntityAttachmentsTbl")
      .select("EntityUID", "FilePath", "FileName")
      .where({ EntityType: entityType, IsDeleted: 0 })
      .whereIn(
        "EntityUID",
        rows.map((row) => toInt(row[key]))
      )
      .orderBy([
        { column: "EntityUID", order: "asc" },
        { column: "SortOrder", order: "asc" },
      ]);
    const gallery = new Map<number, { url: string; name: string }[]>();
    for (const attachment of attachments) {
      const list = gallery.get(toInt(attachment.EntityUID)) ?? [];
      list.push({ url: resolveCdnUrl(attachment.FilePath), name: attachment.FileName });
      gallery.set(toInt(attachment.EntityUID), list);
    }
    for (const row of rows) row.AttachmentsJson = JSON.stringify(gallery.get(toInt(row[key])) ?? []);
  }
}
