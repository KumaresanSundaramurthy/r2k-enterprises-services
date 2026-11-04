import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

// Inventory list filter the CI3 page posts (JSON)
export interface InventoryFilter {
  Search?: string;
  CategoryUID?: unknown;
  ProductUID?: unknown;
  ProductType?: unknown;
  StockStatus?: string;
  SortBy?: string;
  SortDir?: string;
}

// Composite (BOM) parents carry no stock of their own and are left out of every inventory view
export const NOT_A_BOM_PARENT = "NOT EXISTS (SELECT 1 FROM Products.ProductBOMTbl b WHERE b.ParentProductUID = p.ProductUID AND b.IsDeleted = 0)";

const SORT_COLUMNS: Record<string, string> = {
  ItemName: "p.ItemName",
  CategoryName: "c.Name",
  Qty: "ps.AvailableQty",
  PurchasePrice: "p.PurchasePrice",
  SellingPrice: "p.SellingPrice",
};

// Positive integer IDs from an array or a single value
export const intList = (value: unknown): number[] =>
  ([] as unknown[])
    .concat(value ?? [])
    .map((item) => parseInt(String(item), 10))
    .filter((id) => id > 0);

/** Inventory page reads and the manual-adjustment rows (CI3 Inventory_model). */
@Injectable()
export class InventoryRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getInventoryStats — counts and values over active stock products (not BOM parents)
  async stats(orgUID: number): Promise<Row | null> {
    const [rows] = await this.read.raw(
      `SELECT
         SUM(CASE WHEN COALESCE(ps.AvailableQty, 0) > 0 THEN 1 ELSE 0 END) AS positiveCount,
         SUM(CASE WHEN COALESCE(ps.AvailableQty, 0) > 0 THEN COALESCE(ps.AvailableQty, 0) ELSE 0 END) AS positiveQty,
         SUM(CASE WHEN COALESCE(ps.AvailableQty, 0) <= p.LowStockAlertAt THEN 1 ELSE 0 END) AS lowStockCount,
         SUM(CASE WHEN COALESCE(ps.AvailableQty, 0) <= p.LowStockAlertAt THEN COALESCE(ps.AvailableQty, 0) ELSE 0 END) AS lowStockQty,
         SUM(CASE WHEN COALESCE(ps.AvailableQty, 0) > 0 THEN COALESCE(ps.AvailableQty, 0) * p.SellingPrice ELSE 0 END) AS saleValue,
         SUM(CASE WHEN COALESCE(ps.AvailableQty, 0) > 0 THEN COALESCE(ps.AvailableQty, 0) * p.PurchasePrice ELSE 0 END) AS purchaseValue
       FROM Products.ProductTbl p
       LEFT JOIN Products.ProductStockTbl ps ON ps.ProductUID = p.ProductUID
       WHERE p.OrgUID = ? AND p.IsDeleted = 0 AND p.IsActive = 1 AND p.ProductType = 'Product' AND ${NOT_A_BOM_PARENT}`,
      [orgUID]
    );
    return rows[0] ?? null;
  }

  /**
   * getInventoryList — products with their quantity from the stock ledger (IN − OUT), category, unit and who
   * updated them; limit 0 returns every row (export). CI3 always takes this ledger path: the page always
   * has a branch, and the ledger has no branch column, so the quantity covers the whole organisation.
   */
  async list(orgUID: number, filter: InventoryFilter, limit: number, offset: number): Promise<Row[]> {
    const query = this.base(orgUID, filter)
      .select(
        "p.ProductUID",
        "p.ItemName",
        "p.PartNumber",
        this.read.raw("COALESCE(ps.AvailableQty, 0) AS AvailableQuantity"),
        "p.LowStockAlertAt",
        "p.SellingPrice",
        "p.PurchasePrice",
        "p.TaxPercentage",
        "p.ProductType",
        "p.IsRentable",
        "p.IsBrandApplicable",
        "p.UpdatedOn",
        "p.HSNSACCode",
        "p.Description",
        "c.Name as CategoryName",
        "u.ShortName as UnitName",
        this.read.raw("CONCAT(IFNULL(usr.FirstName,''), ' ', IFNULL(usr.LastName,'')) AS UpdatedByName")
      )
      .leftJoin("Global.PrimaryUnitTbl as u", "u.PrimaryUnitUID", "p.PrimaryUnitUID")
      .leftJoin("Users.UserTbl as usr", "usr.UserUID", "p.UpdatedBy")
      .orderBy(SORT_COLUMNS[filter.SortBy ?? ""] ?? "p.ItemName", String(filter.SortDir ?? "").toUpperCase() === "DESC" ? "desc" : "asc");
    if (limit > 0) query.limit(limit).offset(offset);
    return query;
  }

  async count(orgUID: number, filter: InventoryFilter): Promise<number> {
    const row = await this.base(orgUID, filter).count("* as cnt").first();
    return Number(row?.cnt ?? 0);
  }

  // getVariantStockByProduct — each active variant with its stock (CI3 read b.Name, which BrandTbl does not have, so it always failed)
  async variantStock(orgUID: number, productUID: number): Promise<Row[]> {
    return this.read("Products.ProductVariantTbl as pv")
      .select("pv.VariantUID", "b.BrandName as BrandName", "s.Name as SizeName", "pv.PartNumber", "pv.SellingPrice", "pv.PurchasePrice", this.read.raw("COALESCE(pvs.AvailableQty, 0) AS AvailableQty"))
      .leftJoin("Products.BrandTbl as b", "b.BrandUID", "pv.BrandUID")
      .leftJoin("Products.SizeTbl as s", "s.SizeUID", "pv.SizeUID")
      .leftJoin("Products.ProductVariantStockTbl as pvs", (on) => on.on("pvs.VariantUID", "pv.VariantUID").andOn("pvs.OrgUID", "pv.OrgUID"))
      .where({ "pv.ProductUID": productUID, "pv.OrgUID": orgUID, "pv.IsActive": 1 })
      .orderBy([{ column: "b.BrandName" }, { column: "s.Name" }]);
  }

  // searchProducts — stock products (not BOM parents) by name, 50 at most, in the UI language
  async searchProducts(orgUID: number, term: string, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.ProductTbl as p")
      .select("p.ProductUID", this.langColumn(useLang, "PL.ItemName", "p.ItemName", "ItemName"), this.langColumn(useLang, "CL.Name", "cat.Name", "CategoryName"))
      .leftJoin("Products.CategoryTbl as cat", (on) => on.on("cat.CategoryUID", "p.CategoryUID").andOnVal("cat.IsDeleted", "=", 0))
      .where({ "p.OrgUID": orgUID, "p.IsDeleted": 0, "p.IsActive": 1, "p.ProductType": "Product" })
      .whereRaw(NOT_A_BOM_PARENT)
      .orderBy("p.ItemName", "asc")
      .limit(50);
    if (useLang) {
      query
        .leftJoin("Products.ProductTbl_Lang as PL", (on) => on.on("PL.ProductUID", "p.ProductUID").andOnVal("PL.LangCode", "=", langCode))
        .leftJoin("Products.CategoryTbl_Lang as CL", (on) => on.on("CL.CategoryUID", "cat.CategoryUID").andOnVal("CL.LangCode", "=", langCode));
    }
    if (term) query.where("p.ItemName", "like", BaseRepository.likePattern(term));
    return query;
  }

  // getCategories — for the filter dropdown
  async categories(orgUID: number): Promise<Row[]> {
    return this.read("Products.CategoryTbl").select("CategoryUID", "Name as CategoryName").where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 }).orderBy("Name", "asc");
  }

  // Login users for the "updated by" filter (CI3 org-users cache)
  async orgUsers(orgUID: number): Promise<Row[]> {
    return this.read("Users.UserTbl")
      .select("UserUID", "FirstName", "LastName", this.read.raw("CONCAT(FirstName, ' ', LastName) AS FullName"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1, HasLoginAccess: 1 })
      .orderBy("FirstName", "asc");
  }

  // getAdjustmentById
  async adjustment(orgUID: number, adjUID: number): Promise<Row | null> {
    const row = await this.read("Products.StockAdjustmentTbl")
      .select("AdjUID", "ProductUID", "AdjType", "Qty", "Price", "Notes", "RecordDate")
      .where({ AdjUID: adjUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  async insertAdjustment(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx("Products.StockAdjustmentTbl").insert(row);
    return Number(id);
  }

  async updateAdjustment(trx: Knex.Transaction | null, orgUID: number, adjUID: number, data: Row): Promise<void> {
    await (trx ?? this.db.write)("Products.StockAdjustmentTbl").where({ AdjUID: adjUID, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  // getLedgerById — a live stock ledger row of the organisation
  async ledgerRowExists(orgUID: number, ledgerUID: number): Promise<boolean> {
    return !!(await this.read("Products.StockLedgerTbl").select("LedgerUID").where({ LedgerUID: ledgerUID, OrgUID: orgUID, IsDeleted: 0 }).first());
  }

  async updateLedgerRemarks(orgUID: number, ledgerUID: number, remarks: string | null, userUID: number): Promise<void> {
    await this.db.write("Products.StockLedgerTbl").where({ LedgerUID: ledgerUID, OrgUID: orgUID }).update({ Remarks: remarks, UpdatedBy: userUID });
  }

  // Active products (not BOM parents) with the ledger quantity and category joined, filters applied (_applyFilter)
  private base(orgUID: number, filter: InventoryFilter): Knex.QueryBuilder {
    const ledgerQty = this.read.raw(
      `(SELECT ProductUID, SUM(CASE WHEN MovementType = 'IN' THEN Quantity ELSE -Quantity END) AS AvailableQty
          FROM Products.StockLedgerTbl WHERE OrgUID = ? AND IsDeleted = 0 GROUP BY ProductUID) AS ps`,
      [orgUID]
    );
    const query = this.read("Products.ProductTbl as p")
      .leftJoin(ledgerQty, "ps.ProductUID", "p.ProductUID")
      .leftJoin("Products.CategoryTbl as c", (on) => on.on("c.CategoryUID", "p.CategoryUID").andOnVal("c.IsDeleted", "=", 0))
      .where({ "p.OrgUID": orgUID, "p.IsDeleted": 0, "p.IsActive": 1 })
      .whereRaw(NOT_A_BOM_PARENT);

    if (filter.Search) this.whereAnyLike(query, ["p.ItemName", "p.PartNumber"], String(filter.Search));
    const categories = intList(filter.CategoryUID);
    if (categories.length > 0) query.whereIn("p.CategoryUID", categories);
    const products = intList(filter.ProductUID);
    if (products.length > 0) query.whereIn("p.ProductUID", products);
    const types = ([] as unknown[]).concat(filter.ProductType ?? []).filter((type) => type === "Product" || type === "Service");
    if (types.length > 0) query.whereIn("p.ProductType", types as string[]);
    switch (filter.StockStatus) {
      case "LowStock":
        query.whereRaw("COALESCE(ps.AvailableQty, 0) <= p.LowStockAlertAt");
        break;
      case "Positive":
        query.whereRaw("COALESCE(ps.AvailableQty, 0) > 0");
        break;
      case "OutOfStock":
        query.whereRaw("COALESCE(ps.AvailableQty, 0) <= 0");
        break;
    }
    return query;
  }
}
