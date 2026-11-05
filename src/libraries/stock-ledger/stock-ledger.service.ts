import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { phpRound } from "../../common/utils/php-compat";

export type MovementType = "IN" | "OUT";

/*
 * Direction of the stock a saved document moves (CI3 Dbwrite_ext_model::$stockMovementMap): Invoices, Purchase
 * Returns and Delivery Challans take stock out; Purchases, Sales Returns and Credit Notes bring it in.
 */
export const DOCUMENT_STOCK_MOVEMENT: Record<number, MovementType> = { 103: "OUT", 105: "IN", 106: "IN", 107: "IN", 108: "OUT", 112: "OUT" };

// The posted lines of a document (the CI3 Items JSON)
export type DocumentLine = Record<string, unknown>;

export interface DocumentStock {
  orgUID: number;
  userUID: number;
  transUID: number;
  moduleUID: number;
  lines: DocumentLine[];
}

type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value ?? 0) || 0;
const lineProduct = (line: DocumentLine) => (num(line.productUID) > 0 ? Math.trunc(num(line.productUID)) : Math.trunc(num(line.id)));

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

  /**
   * saveStockMovements — one movement per stocked line of a saved document (services are skipped), in the
   * module's direction. A composite product moves its BOM components instead (component qty = BOM qty × line qty)
   * and a snapshot of each component is kept in TransProductBOMTbl. Lines are linked to their TransProductsTbl row
   * by product and variant.
   */
  async saveDocument(trx: Knex.Transaction, doc: DocumentStock): Promise<void> {
    const movementType = DOCUMENT_STOCK_MOVEMENT[doc.moduleUID];
    if (!movementType) return;
    const { orgUID, transUID } = doc;

    const saved: Row[] = await trx("Transaction.TransProductsTbl")
      .select("TransProdUID", "ProductUID", "VariantUID", "UnitPrice", "FinancialYear", trx.raw("(COALESCE(CgstAmount,0)+COALESCE(SgstAmount,0)+COALESCE(IgstAmount,0)) AS TaxAmt"))
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("TransProdUID", "asc");
    const savedLines = new Map<string, { transProdUID: number; sellingPrice: number; taxAmount: number }>();
    for (const row of saved) {
      const key = `${num(row.ProductUID)}-${num(row.VariantUID)}`;
      if (!savedLines.has(key)) savedLines.set(key, { transProdUID: num(row.TransProdUID), sellingPrice: num(row.UnitPrice), taxAmount: num(row.TaxAmt) });
    }
    const financialYear = saved.length > 0 ? String(saved[0].FinancialYear ?? "") : "";

    const stocked = doc.lines.filter((line) => lineProduct(line) > 0 && String(line.productType ?? "").toLowerCase() !== "service");
    const composite = new Set<number>();
    if (stocked.length > 0) {
      const rows: Row[] = await trx("Products.ProductTbl").select("ProductUID", "IsComposite").whereIn("ProductUID", [...new Set(stocked.map(lineProduct))]).where({ OrgUID: orgUID, IsDeleted: 0 });
      for (const row of rows) if (num(row.IsComposite) === 1) composite.add(num(row.ProductUID));
    }

    for (const line of doc.lines) {
      const productUID = lineProduct(line);
      const quantity = num(line.quantity);
      if (productUID <= 0 || quantity <= 0) continue;
      if (String(line.productType ?? "Product").toLowerCase() === "service") continue;
      const variantUID = Math.trunc(num(line.variantUID));
      const link = savedLines.get(`${productUID}-${variantUID}`) ?? null;
      const movement = {
        orgUID,
        userUID: doc.userUID,
        transUID,
        moduleUID: doc.moduleUID,
        movementType,
        unitCost: num(line.unitPrice),
        transProdUID: link?.transProdUID ?? null,
        sellingPrice: link?.sellingPrice ?? null,
        taxAmount: link?.taxAmount ?? null,
      };
      if (composite.has(productUID)) await this.moveComponents(trx, doc, line, productUID, quantity, movement, financialYear);
      else await this.apply(trx, { ...movement, productUID, variantUID, quantity });
    }
  }

  /** reverseStockMovements for a document — its ledger rows are undone and its BOM snapshot rows retired. */
  async reverseDocument(trx: Knex.Transaction, orgUID: number, transUID: number, moduleUID: number, userUID: number): Promise<number[]> {
    const products = await this.reverse(trx, orgUID, transUID, moduleUID, userUID);
    await trx("Transaction.TransProductBOMTbl").where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).update({ IsDeleted: 1, UpdatedBy: userUID });
    return products;
  }

  // A composite line: each BOM component moves, and its priced snapshot is stored against the line
  private async moveComponents(
    trx: Knex.Transaction,
    doc: DocumentStock,
    line: DocumentLine,
    productUID: number,
    quantity: number,
    movement: Omit<StockMovement, "productUID" | "variantUID" | "quantity">,
    financialYear: string
  ): Promise<void> {
    const { orgUID, userUID, transUID } = doc;
    const bom: Row[] = await trx("Products.ProductBOMTbl").select("ChildProductUID", "Quantity").where({ ParentProductUID: productUID, OrgUID: orgUID, IsDeleted: 0, IsActive: 1 });
    if (bom.length === 0) return;
    const details = new Map<number, Row>();
    const rows: Row[] = await trx("Products.ProductTbl as p")
      .select(
        "p.ProductUID",
        "p.ItemName",
        "p.PartNumber",
        "p.Description",
        "p.CategoryUID",
        "cat.Name as CategoryName",
        "p.StorageUID",
        "pu.ShortName as PrimaryUnitName",
        "p.TaxDetailsUID",
        "p.TaxPercentage",
        "p.CGST",
        "p.SGST",
        "p.IGST",
        "p.SellingPrice",
        "p.PurchasePrice"
      )
      .leftJoin("Products.CategoryTbl as cat", (on) => on.on("cat.CategoryUID", "p.CategoryUID").andOnVal("cat.IsDeleted", "=", 0))
      .leftJoin("Global.PrimaryUnitTbl as pu", "pu.PrimaryUnitUID", "p.PrimaryUnitUID")
      .whereIn("p.ProductUID", bom.map((row) => num(row.ChildProductUID)))
      .where({ "p.OrgUID": orgUID, "p.IsDeleted": 0 });
    for (const row of rows) details.set(num(row.ProductUID), row);

    // Prices the form passed for the components (bomComponents), else the catalogue selling price
    const passedPrice = new Map<number, number>();
    const passedSelling = new Map<number, number>();
    for (const component of Array.isArray(line.bomComponents) ? (line.bomComponents as Row[]) : []) {
      const uid = Math.trunc(num(component.childProductUID));
      if (uid <= 0) continue;
      passedPrice.set(uid, num(component.unitPrice));
      passedSelling.set(uid, num(component.sellingPrice ?? component.unitPrice));
    }

    for (const part of bom) {
      const componentUID = num(part.ChildProductUID);
      const componentQty = phpRound(num(part.Quantity) * quantity, 5);
      await this.apply(trx, { ...movement, productUID: componentUID, variantUID: 0, quantity: componentQty });

      const detail = details.get(componentUID);
      if (movement.transProdUID === null || movement.transProdUID === undefined || !detail) continue;
      const price = passedPrice.get(componentUID) ?? num(detail.SellingPrice);
      const sellingPrice = passedSelling.get(componentUID) ?? num(detail.SellingPrice);
      const catalogueSelling = num(detail.SellingPrice);
      const taxPct = num(detail.TaxPercentage);
      const cgstPct = num(detail.CGST);
      const sgstPct = num(detail.SGST);
      const igstPct = num(detail.IGST);
      const taxable = phpRound(price * componentQty, 4);
      const cgst = phpRound((taxable * cgstPct) / 100, 4);
      const sgst = phpRound((taxable * sgstPct) / 100, 4);
      const igst = phpRound((taxable * igstPct) / 100, 4);
      const tax = phpRound(cgst + sgst + igst, 4);
      await trx("Transaction.TransProductBOMTbl").insert({
        ParentTransProdUID: movement.transProdUID,
        OrgUID: orgUID,
        FinancialYear: financialYear,
        TransUID: transUID,
        ProductUID: componentUID,
        ProductName: String(detail.ItemName ?? "").slice(0, 100),
        Description: detail.Description ?? null,
        PartNumber: detail.PartNumber ?? null,
        CategoryUID: detail.CategoryUID ?? null,
        CategoryName: detail.CategoryName ?? null,
        StorageUID: detail.StorageUID ?? null,
        Quantity: componentQty,
        PrimaryUnitName: detail.PrimaryUnitName ?? null,
        TaxDetailsUID: detail.TaxDetailsUID ?? null,
        TaxPercentage: taxPct,
        CGST: cgstPct,
        SGST: sgstPct,
        IGST: igstPct,
        UnitPrice: price,
        SellingPrice: sellingPrice,
        PurchasePrice: num(detail.PurchasePrice),
        OrigUnitPrice: taxPct > 0 ? phpRound(catalogueSelling / (1 + taxPct / 100), 8) : catalogueSelling,
        OrigSellingPrice: catalogueSelling,
        TaxableAmount: taxable,
        CgstAmount: cgst,
        SgstAmount: sgst,
        IgstAmount: igst,
        TaxAmount: tax,
        DiscountTypeUID: null,
        Discount: 0,
        DiscountAmount: 0,
        NetAmount: phpRound(taxable + tax, 4),
        QuantityConverted: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
    }
  }
}
