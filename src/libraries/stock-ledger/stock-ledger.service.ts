import { Injectable } from "@nestjs/common";
import { Knex } from "knex";

export type MovementType = "IN" | "OUT";

export interface StockMovement {
  orgUID: number;
  userUID: number;
  productUID: number;
  variantUID: number;
  // The source record (transaction, or the AdjUID of a manual adjustment) and its module
  transUID: number;
  moduleUID: number;
  movementType: MovementType;
  quantity: number;
  unitCost: number;
  transProdUID?: number | null;
  sellingPrice?: number | null;
  taxAmount?: number | null;
}

/**
 * Stock movements (CI3 Dbwrite_ext_model::_applyStockMovement / reverseStockMovements): a StockLedgerTbl row
 * with a snapshot of the product, and the product's (and variant's) AvailableQty moved with it.
 * Every method runs inside the caller's transaction.
 */
@Injectable()
export class StockLedgerService {
  /**
   * Records one movement. Returns false when the product is not a live product of the organisation
   * (nothing is written then).
   */
  async apply(trx: Knex.Transaction, movement: StockMovement): Promise<boolean> {
    const { orgUID, productUID, variantUID, quantity } = movement;
    const snap = await trx("Products.ProductTbl as p")
      .select(
        "p.ItemName",
        "p.MRP",
        "p.CGST",
        "p.SGST",
        "p.IGST",
        "p.TaxPercentage",
        "p.CategoryUID",
        "c.Name as CategoryName",
        "p.PurchasePrice",
        "p.PartNumber",
        "p.Description"
      )
      .leftJoin("Products.CategoryTbl as c", (on) => on.on("c.CategoryUID", "p.CategoryUID").andOnVal("c.IsDeleted", "=", 0))
      .where({ "p.ProductUID": productUID, "p.OrgUID": orgUID, "p.IsDeleted": 0 })
      .first();
    if (!snap) return false;

    await trx("Products.StockLedgerTbl").insert({
      OrgUID: orgUID,
      ProductUID: productUID,
      VariantUID: variantUID > 0 ? variantUID : null,
      TransUID: movement.transUID,
      TransProdUID: movement.transProdUID ?? null,
      ModuleUID: movement.moduleUID,
      MovementType: movement.movementType,
      Quantity: quantity,
      UnitCost: movement.unitCost,
      SellingPrice: movement.sellingPrice ?? null,
      TaxAmount: movement.taxAmount ?? null,
      Remarks: null,
      SnapItemName: snap.ItemName ?? null,
      SnapMRP: snap.MRP ?? null,
      SnapCGST: snap.CGST ?? null,
      SnapSGST: snap.SGST ?? null,
      SnapIGST: snap.IGST ?? null,
      SnapTaxPercentage: snap.TaxPercentage ?? null,
      SnapCategoryUID: snap.CategoryUID ?? null,
      SnapCategoryName: snap.CategoryName ?? null,
      SnapPurchasePrice: snap.PurchasePrice ?? null,
      SnapPartNumber: snap.PartNumber ?? null,
      SnapDescription: snap.Description ?? null,
      IsDeleted: 0,
      CreatedBy: movement.userUID,
      UpdatedBy: movement.userUID,
    });

    const sign = movement.movementType === "IN" ? 1 : -1;
    await trx("Products.ProductStockTbl")
      .where({ ProductUID: productUID })
      .update({ AvailableQty: trx.raw("CAST(AvailableQty AS SIGNED) + ?", [sign * quantity]) });
    if (variantUID > 0) {
      await trx.raw(
        `INSERT INTO Products.ProductVariantStockTbl (VariantUID, OrgUID, OpeningQty, AvailableQty)
         VALUES (?, ?, 0, ?)
         ON DUPLICATE KEY UPDATE AvailableQty = CAST(AvailableQty AS SIGNED) + ?`,
        [variantUID, orgUID, sign * quantity, sign * quantity]
      );
    }
    return true;
  }

  /**
   * reverseStockMovements — undoes every live ledger row of one source record and soft-deletes them.
   * Rows are matched on the module too: CI3 matched TransUID alone, so reversing adjustment #50 also
   * reversed the stock of transaction #50.
   */
  async reverse(trx: Knex.Transaction, orgUID: number, transUID: number, moduleUID: number, userUID: number): Promise<number[]> {
    const rows: { LedgerUID: string; ProductUID: string; VariantUID: string | null; MovementType: string; Quantity: string }[] = await trx(
      "Products.StockLedgerTbl"
    )
      .select("LedgerUID", "ProductUID", "VariantUID", "MovementType", "Quantity")
      .where({ TransUID: transUID, ModuleUID: moduleUID, OrgUID: orgUID, IsDeleted: 0 });

    for (const row of rows) {
      const quantity = Number(row.Quantity);
      const delta = row.MovementType === "IN" ? -quantity : quantity;
      await trx("Products.ProductStockTbl")
        .where({ ProductUID: Number(row.ProductUID) })
        .update({ AvailableQty: trx.raw("CAST(AvailableQty AS SIGNED) + ?", [delta]) });
      if (Number(row.VariantUID) > 0) {
        await trx("Products.ProductVariantStockTbl")
          .where({ VariantUID: Number(row.VariantUID), OrgUID: orgUID })
          .update({ AvailableQty: trx.raw("CAST(AvailableQty AS SIGNED) + ?", [delta]) });
      }
      await trx("Products.StockLedgerTbl").where({ LedgerUID: Number(row.LedgerUID) }).update({ IsDeleted: 1, UpdatedBy: userUID });
    }
    return [...new Set(rows.map((row) => Number(row.ProductUID)))];
  }
}
