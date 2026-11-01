import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { MODULE_UID } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { Row } from "./products.repository";

const SALES = [MODULE_UID.Invoices, MODULE_UID.DeliveryChallans];
const STOCK_MODULES = [MODULE_UID.Invoices, MODULE_UID.Purchases, MODULE_UID.SalesReturns, MODULE_UID.PurchaseReturns, MODULE_UID.DeliveryChallans];

// Product profile modal queries (CI3 Products_model profile section). All read-only.
@Injectable()
export class ProductProfileRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getProductProfile — product details, sales / purchase totals and the first image
  async profile(orgUID: number, productUID: number, langCode: string): Promise<Row | null> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.ProductTbl as P")
      .select(
        "P.ProductUID as ProductUID",
        this.langColumn(useLang, "PTL.ItemName", "P.ItemName", "ItemName"),
        "P.PartNumber as PartNumber",
        "P.SKU as SKU",
        "P.ProductType as ProductType",
        "P.IsComposite as IsComposite",
        "P.Description as Description",
        "P.SellingPrice as SellingPrice",
        "P.PurchasePrice as PurchasePrice",
        "P.MRP as MRP",
        "P.TaxPercentage as TaxPercentage",
        "P.LowStockAlertAt as LowStockAlertAt",
        "P.OpeningQuantity as OpeningQuantity",
        "P.IsRentable as IsRentable",
        "P.NotForSale as NotForSale",
        "P.HSNSACCode as HSNSACCode",
        "P.CreatedOn as CreatedOn",
        "P.UpdatedOn as UpdatedOn",
        this.langColumn(useLang, "CTL.Name", "Cat.Name", "CategoryName"),
        "SelTax.Name as SellingTaxType",
        "PurTax.Name as PurchaseTaxType",
        "Unit.ShortName as UnitShortName",
        this.read.raw(
          "CASE WHEN (P.IsSizeApplicable = 1 OR P.IsBrandApplicable = 1) THEN COALESCE((SELECT SUM(pvs2.AvailableQty) FROM Products.ProductVariantStockTbl pvs2 JOIN Products.ProductVariantTbl pv2 ON pv2.VariantUID = pvs2.VariantUID AND pv2.OrgUID = pvs2.OrgUID WHERE pv2.ProductUID = P.ProductUID AND pvs2.OrgUID = P.OrgUID AND pv2.IsActive = 1), 0) ELSE COALESCE(PS.AvailableQty, 0) END AS AvailableQty"
        )
      )
      .leftJoin("Products.CategoryTbl as Cat", "Cat.CategoryUID", "P.CategoryUID")
      .leftJoin("Products.ProductStockTbl as PS", "PS.ProductUID", "P.ProductUID")
      .leftJoin("Global.ProductTaxTbl as SelTax", "SelTax.ProductTaxUID", "P.SellingProductTaxUID")
      .leftJoin("Global.ProductTaxTbl as PurTax", "PurTax.ProductTaxUID", "P.PurchasePriceProductTaxUID")
      .leftJoin("Global.PrimaryUnitTbl as Unit", "Unit.PrimaryUnitUID", "P.PrimaryUnitUID")
      .where({ "P.ProductUID": productUID, "P.OrgUID": orgUID, "P.IsDeleted": 0 });
    if (useLang) {
      query
        .leftJoin("Products.ProductTbl_Lang as PTL", (on) => {
          on.on("PTL.ProductUID", "P.ProductUID").andOnVal("PTL.LangCode", "=", langCode);
        })
        .leftJoin("Products.CategoryTbl_Lang as CTL", (on) => {
          on.on("CTL.CategoryUID", "P.CategoryUID").andOnVal("CTL.LangCode", "=", langCode);
        });
    }
    const row: Row | undefined = await query.first();
    if (!row) return null;

    const sales = `Ts.ModuleUID IN (${SALES.join(",")}) AND Ts.DocStatus NOT IN ('Draft','Cancelled')`;
    const purchases = `Ts.ModuleUID = ${MODULE_UID.Purchases} AND Ts.DocStatus NOT IN ('Draft','Cancelled')`;
    const [statsResult, image] = await Promise.all([
      this.read.raw(
        `SELECT
           COALESCE(SUM(CASE WHEN ${sales} THEN Tp.Quantity ELSE 0 END), 0) AS TotalUnitsSold,
           COALESCE(SUM(CASE WHEN ${sales} THEN Tp.UnitPrice * Tp.Quantity ELSE 0 END), 0) AS TotalRevenue,
           COALESCE(SUM(CASE WHEN ${purchases} THEN Tp.Quantity ELSE 0 END), 0) AS TotalUnitsPurchased,
           COUNT(DISTINCT CASE WHEN ${sales} THEN Ts.TransUID ELSE NULL END) AS SalesTxCount
         FROM Transaction.TransProductsTbl AS Tp
         JOIN Transaction.TransactionsTbl AS Ts ON Ts.TransUID = Tp.TransUID AND Ts.IsDeleted = 0
         WHERE Tp.ProductUID = ? AND Tp.OrgUID = ? AND Tp.IsDeleted = 0`,
        [productUID, orgUID]
      ),
      this.read("Products.EntityAttachmentsTbl")
        .select("FilePath")
        .where({ EntityType: "Product", EntityUID: productUID, OrgUID: orgUID, IsDeleted: 0 })
        .orderBy("SortOrder", "asc")
        .first(),
    ]);
    const stats = statsResult[0][0] ?? {};
    return {
      ...row,
      TotalUnitsSold: Number(stats.TotalUnitsSold ?? 0),
      TotalRevenue: Number(stats.TotalRevenue ?? 0),
      TotalUnitsPurchased: Number(stats.TotalUnitsPurchased ?? 0),
      SalesTxCount: Number(stats.SalesTxCount ?? 0),
      ImageUrl: image ? resolveCdnUrl(image.FilePath) : null,
    } as unknown as Row;
  }

  // getProductTopCustomers — top 5 customers by quantity (confirmed invoices + delivery challans)
  async topCustomers(orgUID: number, productUID: number): Promise<Row[]> {
    const result = await this.read.raw(
      `SELECT Cust.Name AS CustomerName, COUNT(DISTINCT Ts.TransUID) AS TxCount, SUM(Tp.Quantity) AS TotalQty
       FROM Transaction.TransProductsTbl AS Tp
       JOIN Transaction.TransactionsTbl AS Ts
            ON Ts.TransUID = Tp.TransUID AND Ts.ModuleUID IN (${SALES.join(",")})
           AND Ts.DocStatus NOT IN ('Draft','Cancelled') AND Ts.IsDeleted = 0
       JOIN Customers.CustomerTbl AS Cust ON Cust.CustomerUID = Ts.PartyUID
       WHERE Tp.ProductUID = ? AND Tp.OrgUID = ? AND Tp.IsDeleted = 0
       GROUP BY Cust.CustomerUID, Cust.Name
       ORDER BY TotalQty DESC
       LIMIT 5`,
      [productUID, orgUID]
    );
    return result[0];
  }

  // getProductTransactionHistory — newest 100 transaction lines of the product
  async transactions(orgUID: number, productUID: number): Promise<Row[]> {
    const result = await this.read.raw(
      `SELECT Ts.TransUID, Ts.UniqueNumber, Ts.TransDate, Ts.ModuleUID, Ts.DocStatus, Ts.PartyType,
              Cust.Name AS CustomerName, Vend.Name AS VendorName,
              Tp.Quantity, Tp.UnitPrice, Tp.NetAmount AS LineAmount, Tp.VariantLabel
       FROM Transaction.TransProductsTbl AS Tp
       JOIN Transaction.TransactionsTbl AS Ts ON Ts.TransUID = Tp.TransUID AND Ts.IsDeleted = 0
       LEFT JOIN Customers.CustomerTbl AS Cust ON Cust.CustomerUID = Ts.PartyUID AND Ts.PartyType = 'C'
       LEFT JOIN Vendors.VendorTbl AS Vend ON Vend.VendorUID = Ts.PartyUID AND Ts.PartyType = 'S'
       WHERE Tp.ProductUID = ? AND Tp.OrgUID = ? AND Tp.IsDeleted = 0
       ORDER BY Ts.TransDate DESC, Ts.TransUID DESC
       LIMIT 100`,
      [productUID, orgUID]
    );
    return result[0];
  }

  // getProductStockMovements — confirmed stock-affecting lines, oldest first (running stock ledger)
  async stockMovements(orgUID: number, productUID: number): Promise<Row[]> {
    const result = await this.read.raw(
      `SELECT Ts.TransUID, Ts.UniqueNumber, Ts.TransDate, Ts.ModuleUID, Ts.DocStatus, Ts.PartyType,
              Cust.Name AS CustomerName, Vend.Name AS VendorName, Tp.Quantity
       FROM Transaction.TransProductsTbl AS Tp
       JOIN Transaction.TransactionsTbl AS Ts
            ON Ts.TransUID = Tp.TransUID AND Ts.IsDeleted = 0
           AND Ts.ModuleUID IN (${STOCK_MODULES.join(",")}) AND Ts.DocStatus NOT IN ('Draft','Cancelled')
       LEFT JOIN Customers.CustomerTbl AS Cust ON Cust.CustomerUID = Ts.PartyUID AND Ts.PartyType = 'C'
       LEFT JOIN Vendors.VendorTbl AS Vend ON Vend.VendorUID = Ts.PartyUID AND Ts.PartyType = 'S'
       WHERE Tp.ProductUID = ? AND Tp.OrgUID = ? AND Tp.IsDeleted = 0
       ORDER BY Ts.TransDate ASC, Ts.TransUID ASC`,
      [productUID, orgUID]
    );
    return result[0];
  }

  // getProductAuditHistory — newest 100 audit entries of the product (the table has CreatedOn; CI3 asked for a
  // CreatedAt column, so its history was always empty — returned here as CreatedAt, the name the CI3 view reads)
  async auditHistory(orgUID: number, productUID: number): Promise<Row[]> {
    return this.read("Security.UserAuditLogTbl")
      .select(
        "Action",
        "EntityType",
        "Module",
        "EntityRef",
        "Summary",
        "UserName",
        "IPAddress",
        "Source",
        "DeviceType",
        "AuditCategory",
        "OldValues",
        "NewValues",
        "CreatedOn as CreatedAt"
      )
      .where({ EntityType: "Product", EntityUID: productUID, OrgUID: orgUID })
      .orderBy("CreatedOn", "desc")
      .limit(100);
  }
}
