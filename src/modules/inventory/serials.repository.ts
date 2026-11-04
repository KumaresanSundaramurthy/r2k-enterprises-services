import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const SERIALS = "Transaction.ProductSerialsTbl";

// Serial list filter the CI3 page posts: status tab, search text, product
export interface SerialFilter {
  Status?: string;
  search?: string;
  ProductUID?: unknown;
}

export const SERIAL_STATUSES = ["Available", "Sold", "Returned", "Damaged"];

/** Serial numbers of serial-tracked products (CI3 Inventory_model serial methods). */
@Injectable()
export class SerialsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getSerialsList — newest first, with the purchase / sale / return transaction numbers
  async list(orgUID: number, filter: SerialFilter, limit: number, offset: number): Promise<Row[]> {
    return this.base(orgUID, filter)
      .select(
        "ps.SerialUID",
        "ps.SerialNumber",
        "ps.Status",
        "ps.Notes",
        "ps.PurchaseTransUID",
        "ps.SaleTransUID",
        "ps.ReturnTransUID",
        "ps.CreatedAt",
        "p.ProductUID",
        "p.ItemName",
        "p.PartNumber",
        this.read.raw("CASE WHEN ps.PurchaseTransUID IS NOT NULL THEN 'Purchase' ELSE 'Manual' END AS SourceType"),
        "pt.UniqueNumber as PurchaseTransNo",
        "st.UniqueNumber as SaleTransNo",
        "rt.UniqueNumber as ReturnTransNo"
      )
      .leftJoin("Transaction.TransactionsTbl as pt", "pt.TransUID", "ps.PurchaseTransUID")
      .leftJoin("Transaction.TransactionsTbl as st", "st.TransUID", "ps.SaleTransUID")
      .leftJoin("Transaction.TransactionsTbl as rt", "rt.TransUID", "ps.ReturnTransUID")
      .orderBy("ps.CreatedAt", "desc")
      .limit(limit)
      .offset(offset);
  }

  async count(orgUID: number, filter: SerialFilter): Promise<number> {
    const row = await this.base(orgUID, filter).count("* as cnt").first();
    return Number(row?.cnt ?? 0);
  }

  // getSerialsStats — count per status and the total
  async stats(orgUID: number): Promise<Record<string, number>> {
    const rows: Row[] = await this.read(SERIALS).select("Status").count("* as cnt").where({ OrgUID: orgUID, IsDeleted: 0 }).groupBy("Status");
    const stats: Record<string, number> = { Available: 0, Sold: 0, Returned: 0, Damaged: 0, total: 0 };
    for (const row of rows) {
      stats[String(row.Status)] = Number(row.cnt);
      stats.total += Number(row.cnt);
    }
    return stats;
  }

  // searchSerialProducts — serial-tracked products by name, 50 at most
  async searchProducts(orgUID: number, term: string): Promise<Row[]> {
    const query = this.read("Products.ProductTbl as p")
      .select("p.ProductUID", "p.ItemName")
      .where({ "p.OrgUID": orgUID, "p.IsDeleted": 0, "p.IsActive": 1, "p.IsSerialTracked": 1 })
      .orderBy("p.ItemName", "asc")
      .limit(50);
    if (term) query.where("p.ItemName", "like", BaseRepository.likePattern(term));
    return query;
  }

  // A live product of the organisation
  async productExists(orgUID: number, productUID: number): Promise<boolean> {
    return !!(await this.read("Products.ProductTbl").select("ProductUID").where({ ProductUID: productUID, OrgUID: orgUID, IsDeleted: 0 }).first());
  }

  // serialExists
  async exists(orgUID: number, productUID: number, serialNumber: string): Promise<boolean> {
    return !!(await this.read(SERIALS).select("SerialUID").where({ OrgUID: orgUID, ProductUID: productUID, SerialNumber: serialNumber, IsDeleted: 0 }).first());
  }

  async insert(row: Row): Promise<number> {
    const [id] = await this.db.write(SERIALS).insert(row);
    return Number(id);
  }

  // Number of rows changed (0 when the serial is not a live one of the organisation)
  async setStatus(orgUID: number, serialUID: number, status: string, userUID: number): Promise<number> {
    return this.db.write(SERIALS).where({ SerialUID: serialUID, OrgUID: orgUID, IsDeleted: 0 }).update({ Status: status, UpdatedBy: userUID });
  }

  private base(orgUID: number, filter: SerialFilter): Knex.QueryBuilder {
    const query = this.read(`${SERIALS} as ps`)
      .join("Products.ProductTbl as p", (on) => on.on("p.ProductUID", "ps.ProductUID").andOnVal("p.IsDeleted", "=", 0))
      .where({ "ps.OrgUID": orgUID, "ps.IsDeleted": 0 });
    if (filter.Status) query.where("ps.Status", filter.Status);
    if (filter.search) this.whereAnyLike(query, ["ps.SerialNumber", "p.ItemName"], String(filter.search));
    if (Number(filter.ProductUID) > 0) query.where("ps.ProductUID", parseInt(String(filter.ProductUID), 10));
    return query;
  }
}
