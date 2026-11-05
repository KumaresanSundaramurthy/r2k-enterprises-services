import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { nowDateTime, phpBool, phpRound } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const LIST = "Products.PurchasePriceListTbl";
const LOG = "Products.PurchasePriceLogTbl";

// List filter: search words (each must match item name, SKU, vendor, HSN or bill number), product, vendor
export interface PriceListFilter {
  search?: string;
  ProductUID?: unknown;
  VendorUID?: unknown;
}

// Columns of a price list entry (the latest purchase of one product from one vendor)
const ENTRY_COLUMNS = [
  "L.PriceListUID",
  "L.ProductUID",
  "L.VendorUID",
  "L.BranchUID",
  "L.PurchasePrice",
  "L.IsPurchasePriceIncl",
  "L.TaxPct",
  "L.CGSTAmt",
  "L.SGSTAmt",
  "L.IGSTAmt",
  "L.Qty",
  "L.Unit",
  "L.DiscountPct",
  "L.DiscountAmt",
  "L.TotalAmt",
  "L.HSNCode",
  "L.VariantUID",
  "L.LastTransUID",
  "L.LastUniqueNumber",
  "L.LastPurchaseDate",
  "L.FinancialYear",
];

/** Purchase price list (CI3 Purchasepricelist_model): latest price per product + vendor, and its price history. */
@Injectable()
export class PurchasePriceListRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getPriceList — the branch's entries, most recently updated first
  async list(orgUID: number, branchUID: number, filter: PriceListFilter, limit: number, offset: number): Promise<{ rows: Row[]; total: number }> {
    const counted = await this.base(orgUID, branchUID, filter).count("L.PriceListUID as Total").first();
    const total = Number(counted?.Total ?? 0);
    if (total === 0) return { rows: [], total };
    const rows = await this.base(orgUID, branchUID, filter)
      .select(...ENTRY_COLUMNS, "L.UpdatedOn", "P.ItemName", "P.SKU", "V.Name as VendorName", this.read.raw("CONCAT(U.FirstName, ' ', U.LastName) AS UpdatedByName"))
      .leftJoin("Users.UserTbl as U", "U.UserUID", "L.UpdatedBy")
      .orderBy([{ column: "L.UpdatedOn", order: "desc" }, { column: "L.PriceListUID", order: "desc" }])
      .limit(limit)
      .offset(offset);
    return { rows, total };
  }

  // getDetailEntry — one entry of the organisation with its product and vendor
  async entry(orgUID: number, priceListUID: number): Promise<Row | null> {
    const row = await this.read(`${LIST} as L`)
      .select(...ENTRY_COLUMNS, "L.CreatedOn", "L.UpdatedOn", "P.ItemName", "P.SKU", "P.Description as ProductDescription", "V.Name as VendorName")
      .leftJoin("Products.ProductTbl as P", (on) => on.on("P.ProductUID", "L.ProductUID").andOnVal("P.IsDeleted", "=", 0))
      .leftJoin("Vendors.VendorTbl as V", "V.VendorUID", "L.VendorUID")
      .where({ "L.PriceListUID": priceListUID, "L.OrgUID": orgUID })
      .first();
    return row ?? null;
  }

  // getPriceHistory — every logged purchase price of the product from the vendor, newest first
  async history(orgUID: number, productUID: number, vendorUID: number, limit: number, offset: number): Promise<{ rows: Row[]; total: number }> {
    const scope = { "L.OrgUID": orgUID, "L.ProductUID": productUID, "L.VendorUID": vendorUID, "L.IsDeleted": 0 };
    const counted = await this.read(`${LOG} as L`).count("L.PriceLogUID as Total").where(scope).first();
    const total = Number(counted?.Total ?? 0);
    if (total === 0) return { rows: [], total };
    const rows = await this.read(`${LOG} as L`)
      .select(
        "L.PriceLogUID",
        "L.EntryDate",
        "L.PurchasePrice",
        "L.Qty",
        "L.Unit",
        "L.PreviousPrice",
        "L.PriceDiff",
        "L.PriceDiffPct",
        "L.Direction",
        "L.Source",
        "L.TransactionUID",
        "L.Remarks",
        "L.CreatedAt"
      )
      .where(scope)
      .orderBy([{ column: "L.EntryDate", order: "desc" }, { column: "L.PriceLogUID", order: "desc" }])
      .limit(limit)
      .offset(offset);
    return { rows, total };
  }

  private base(orgUID: number, branchUID: number, filter: PriceListFilter): Knex.QueryBuilder {
    const query = this.read(`${LIST} as L`)
      .leftJoin("Products.ProductTbl as P", (on) => on.on("P.ProductUID", "L.ProductUID").andOnVal("P.IsDeleted", "=", 0))
      .leftJoin("Vendors.VendorTbl as V", "V.VendorUID", "L.VendorUID")
      .where({ "L.OrgUID": orgUID, "L.BranchUID": branchUID });
    if (Number(filter.ProductUID) > 0) query.where("L.ProductUID", parseInt(String(filter.ProductUID), 10));
    if (Number(filter.VendorUID) > 0) query.where("L.VendorUID", parseInt(String(filter.VendorUID), 10));
    for (const word of String(filter.search ?? "").trim().split(/\s+/).filter(Boolean)) {
      this.whereAnyLike(query, ["P.ItemName", "P.SKU", "V.Name", "L.HSNCode", "L.LastUniqueNumber"], word);
    }
    return query;
  }

  /**
   * upsertFromPurchase — each line of a saved purchase bill becomes the product's latest price from the vendor
   * (one entry per branch + product + vendor). The price stored is the line's unit price before tax; a missing tax
   * rate is worked out from the tax amounts and a missing total from price, tax and discount.
   */
  async upsertFromPurchase(
    bill: { orgUID: number; branchUID: number; vendorUID: number; transUID: number; transDate: string; uniqueNumber: string; financialYear: string; userUID: number },
    lines: Row[]
  ): Promise<void> {
    const now = nowDateTime();
    for (const line of lines) {
      const productUID = Math.trunc(Number(line.id ?? 0) || 0);
      const qty = Number(line.quantity ?? 0) || 0;
      if (productUID <= 0 || qty <= 0) continue;
      const price = Number(line.unitPrice ?? 0) || 0;
      const cgst = Number(line.cgstAmount ?? 0) || 0;
      const sgst = Number(line.sgstAmount ?? 0) || 0;
      const igst = Number(line.igstAmount ?? 0) || 0;
      const discountAmt = Number(line.discount_amount ?? 0) || 0;
      const lineTax = cgst + sgst + igst;
      let taxPct = Number(line.taxPercent ?? 0) || 0;
      if (taxPct === 0 && lineTax > 0 && price > 0) taxPct = phpRound((lineTax / (price * qty)) * 100, 4);
      let total = Number(line.net_total ?? 0) || 0;
      if (total === 0 && price > 0) total = phpRound(price * qty + lineTax - discountAmt, 4);

      await this.db.write(LIST)
        .insert({
          OrgUID: bill.orgUID,
          BranchUID: bill.branchUID,
          ProductUID: productUID,
          VendorUID: bill.vendorUID,
          PurchasePrice: price,
          IsPurchasePriceIncl: (typeof line.purchasePriceIsIncl === "boolean" ? line.purchasePriceIsIncl : phpBool(line.purchasePriceIsIncl)) ? 1 : 0,
          TaxPct: taxPct,
          CGSTAmt: cgst,
          SGSTAmt: sgst,
          IGSTAmt: igst,
          Qty: qty,
          Unit: String(line.primaryUnit ?? "").slice(0, 50),
          DiscountPct: Number(line.discount ?? 0) || 0,
          DiscountAmt: discountAmt,
          TotalAmt: total,
          HSNCode: String(line.hsnCode ?? "").slice(0, 50),
          VariantUID: Number(line.variantUID ?? 0) > 0 ? Math.trunc(Number(line.variantUID)) : null,
          LastTransUID: bill.transUID,
          LastUniqueNumber: bill.uniqueNumber,
          LastPurchaseDate: bill.transDate,
          FinancialYear: bill.financialYear,
          CreatedBy: bill.userUID,
          CreatedOn: now,
          UpdatedBy: bill.userUID,
          UpdatedOn: now,
        })
        .onConflict()
        .merge([
          "PurchasePrice",
          "IsPurchasePriceIncl",
          "TaxPct",
          "CGSTAmt",
          "SGSTAmt",
          "IGSTAmt",
          "Qty",
          "Unit",
          "DiscountPct",
          "DiscountAmt",
          "TotalAmt",
          "HSNCode",
          "VariantUID",
          "LastTransUID",
          "LastUniqueNumber",
          "LastPurchaseDate",
          "FinancialYear",
          "UpdatedBy",
          "UpdatedOn",
        ]);
    }
  }
}
