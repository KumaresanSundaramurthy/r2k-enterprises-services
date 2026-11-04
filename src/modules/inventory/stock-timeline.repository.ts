import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { intList, NOT_A_BOM_PARENT } from "./inventory.repository";

type Row = Record<string, unknown>;

// Timeline filter the CI3 page posts (JSON)
export interface TimelineFilter {
  ProductUID?: unknown;
  DateFrom?: string;
  DateTo?: string;
  MovementType?: string;
  CategoryUID?: unknown;
  ModuleUID?: unknown;
  CreatedByUID?: unknown;
  SortBy?: string;
  SortDir?: string;
}

// A movement's date: its transaction's date, else its adjustment's date, else the day it was recorded
const EFFECTIVE_DATE = "COALESCE(ts.TransDate, sa.RecordDate, DATE(sl.CreatedOn))";

const SORT_COLUMNS: Record<string, string> = {
  ItemName: "p.ItemName",
  Price: "COALESCE(sl.SellingPrice, sl.UnitCost)",
  Category: "cat.Name",
  Date: EFFECTIVE_DATE,
};

/*
 * Movement sources: the transaction (invoices, purchases, returns) or the manual adjustment (module 118).
 * sa_fb recovers the adjustment of old rows saved with TransUID 0, by product, type and quantity.
 */
const SOURCE_JOINS = `
  LEFT JOIN Transaction.TransactionsTbl ts
         ON ts.TransUID = sl.TransUID AND sl.ModuleUID NOT IN (118) AND ts.IsDeleted = 0
  LEFT JOIN Products.StockAdjustmentTbl sa
         ON sa.AdjUID = sl.TransUID AND sl.ModuleUID = 118 AND sa.IsDeleted = 0`;
const FALLBACK_ADJUSTMENT_JOIN = `
  LEFT JOIN Products.StockAdjustmentTbl sa_fb
         ON sl.ModuleUID = 118 AND sl.TransUID = 0 AND sa.AdjUID IS NULL
        AND sa_fb.AdjUID = (
              SELECT MAX(sa2.AdjUID) FROM Products.StockAdjustmentTbl sa2
               WHERE sa2.IsDeleted = 0 AND sa2.OrgUID = sl.OrgUID AND sa2.ProductUID = sl.ProductUID
                 AND sa2.AdjType COLLATE utf8mb4_unicode_ci = sl.MovementType COLLATE utf8mb4_unicode_ci
                 AND sa2.Qty = sl.Quantity)`;
const REMARKS = "COALESCE(NULLIF(sl.Remarks, ''), NULLIF(COALESCE(sa.Notes, sa_fb.Notes), '')) AS Remarks";
const PRODUCT_JOIN = `INNER JOIN Products.ProductTbl p ON p.ProductUID = sl.ProductUID AND p.IsDeleted = 0 AND ${NOT_A_BOM_PARENT}`;

/** Stock movement history (CI3 Inventory_model timeline queries). */
@Injectable()
export class StockTimelineRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getStockTimeline — a product's last 200 movements
  async productTimeline(orgUID: number, productUID: number): Promise<Row[]> {
    const [rows] = await this.read.raw(
      `SELECT sl.LedgerUID, sl.ModuleUID, sl.MovementType, sl.Quantity, sl.UnitCost, sl.SellingPrice, sl.TaxAmount, sl.CreatedOn,
              ${REMARKS},
              ts.TransNumber, ts.UniqueNumber, ts.DocStatus AS TransStatus,
              COALESCE(sa.AdjUID, sa_fb.AdjUID) AS AdjUID,
              COALESCE(sa.AdjCategory, sa_fb.AdjCategory) AS AdjCategory,
              COALESCE(sa.AdjType, sa_fb.AdjType) AS AdjType,
              COALESCE(ts.TransDate, sa.RecordDate, sa_fb.RecordDate, DATE(sl.CreatedOn)) AS EffectiveDate
         FROM Products.StockLedgerTbl sl
         ${SOURCE_JOINS}
         ${FALLBACK_ADJUSTMENT_JOIN}
        WHERE sl.ProductUID = ? AND sl.OrgUID = ? AND sl.IsDeleted = 0
        ORDER BY sl.LedgerUID DESC
        LIMIT 200`,
      [productUID, orgUID]
    );
    return rows;
  }

  // getGlobalTimeline / getGlobalTimelineExport — every movement of the organisation; limit 0 returns all (export)
  async list(orgUID: number, filter: TimelineFilter, limit: number, offset: number): Promise<Row[]> {
    const params: (string | number)[] = [orgUID];
    const where = StockTimelineRepository.where(filter, params);
    const sortColumn = SORT_COLUMNS[filter.SortBy ?? ""] ?? "sl.LedgerUID";
    const sortDir = String(filter.SortDir ?? "").toUpperCase() === "ASC" ? "ASC" : "DESC";
    let paging = "";
    if (limit > 0) {
      paging = "LIMIT ? OFFSET ?";
      params.push(limit, offset);
    }
    const [rows] = await this.read.raw(
      `SELECT sl.LedgerUID, sl.ModuleUID, sl.MovementType, sl.Quantity, sl.UnitCost, sl.SellingPrice, sl.TaxAmount, sl.CreatedOn,
              sl.TransUID, sl.TransProdUID,
              ${REMARKS},
              p.ProductUID,
              COALESCE(sl.SnapItemName, p.ItemName) AS ItemName,
              sl.SnapItemName, p.HSNSACCode, p.ProductType,
              COALESCE(tp.PartNumber, p.PartNumber) AS PartNumber,
              COALESCE(tp.Description, p.Description) AS Description,
              COALESCE(tp.PrimaryUnitName, pu.ShortName) AS UnitName,
              cat.Name AS CategoryName,
              ts.TransUID AS TransactionUID, ts.TransNumber, ts.UniqueNumber, ts.TransDate, ts.DocStatus,
              COALESCE(sa.AdjUID, sa_fb.AdjUID) AS AdjUID,
              COALESCE(sa.AdjCategory, sa_fb.AdjCategory) AS AdjCategory,
              COALESCE(sa.RecordDate, sa_fb.RecordDate) AS AdjDate,
              CONCAT(IFNULL(usr.FirstName,''), ' ', IFNULL(usr.LastName,'')) AS CreatedByName,
              COALESCE(ts.TransDate, sa.RecordDate, sa_fb.RecordDate, DATE(sl.CreatedOn)) AS EffectiveDate
         FROM Products.StockLedgerTbl sl
         ${PRODUCT_JOIN}
         LEFT JOIN Products.CategoryTbl cat ON cat.CategoryUID = p.CategoryUID AND cat.IsDeleted = 0
         LEFT JOIN Global.PrimaryUnitTbl pu ON pu.PrimaryUnitUID = p.PrimaryUnitUID
         LEFT JOIN Transaction.TransProductsTbl tp ON tp.TransProdUID = sl.TransProdUID AND tp.IsDeleted = 0
         ${SOURCE_JOINS}
         ${FALLBACK_ADJUSTMENT_JOIN}
         LEFT JOIN Users.UserTbl usr ON usr.UserUID = sl.CreatedBy
        WHERE sl.OrgUID = ? AND sl.IsDeleted = 0 ${where}
        ORDER BY ${limit > 0 ? `${sortColumn} ${sortDir}` : "sl.LedgerUID DESC"}
        ${paging}`,
      params
    );
    return rows;
  }

  // getGlobalTimelineCount
  async count(orgUID: number, filter: TimelineFilter): Promise<number> {
    const params: (string | number)[] = [orgUID];
    const where = StockTimelineRepository.where(filter, params);
    const [rows] = await this.read.raw(
      `SELECT COUNT(*) AS cnt
         FROM Products.StockLedgerTbl sl
         ${PRODUCT_JOIN}
         ${SOURCE_JOINS}
        WHERE sl.OrgUID = ? AND sl.IsDeleted = 0 ${where}`,
      params
    );
    return Number(rows[0]?.cnt ?? 0);
  }

  // GenSettings->ListDateFormat (CI3 format_datedisplay default d-m-Y)
  async listDateFormat(orgUID: number): Promise<string> {
    const row = await this.read("Settings.OrgSettingsTbl").select("ListDateFormat").where({ OrgUID: orgUID }).first();
    return row?.ListDateFormat || "d-m-Y";
  }

  // Userpreferences_model::getUserPreference
  async preference(orgUID: number, branchUID: number, userUID: number, key: string): Promise<string | null> {
    const row = await this.read("Users.UserPreferencesTbl").select("PreferenceValue").where({ OrgUID: orgUID, BranchUID: branchUID, UserUID: userUID, PreferenceKey: key }).first();
    return row?.PreferenceValue ?? null;
  }

  // _buildTimelineWhere — every value is a bound parameter
  private static where(filter: TimelineFilter, params: (string | number)[]): string {
    let where = "";
    const inList = (column: string, ids: number[]) => {
      if (ids.length === 0) return;
      where += ` AND ${column} IN (${ids.map(() => "?").join(",")})`;
      params.push(...ids);
    };
    inList("sl.ProductUID", intList(filter.ProductUID));
    if (filter.DateFrom) {
      where += ` AND ${EFFECTIVE_DATE} >= ?`;
      params.push(filter.DateFrom);
    }
    if (filter.DateTo) {
      where += ` AND ${EFFECTIVE_DATE} <= ?`;
      params.push(filter.DateTo);
    }
    if (filter.MovementType) {
      where += " AND sl.MovementType = ?";
      params.push(filter.MovementType);
    }
    inList("p.CategoryUID", intList(filter.CategoryUID));
    inList("sl.ModuleUID", intList(filter.ModuleUID));
    inList("sl.CreatedBy", intList(filter.CreatedByUID));
    return where;
  }
}
