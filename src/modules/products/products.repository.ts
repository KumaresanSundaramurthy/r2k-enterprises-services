import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { toInt } from "../../common/utils/php-compat";
import { ProductListFilterDto } from "./dto/product-list.dto";

export type Row = Record<string, string | null>;

// Stock of a product: variants' total for size / brand products, otherwise ProductStockTbl (CI3 AvailableQuantity CASE)
const availableQty = (p: string, stock: string) =>
  `CASE WHEN (${p}.IsSizeApplicable = 1 OR ${p}.IsBrandApplicable = 1) THEN COALESCE((SELECT SUM(pvs2.AvailableQty) FROM Products.ProductVariantStockTbl pvs2 JOIN Products.ProductVariantTbl pv2 ON pv2.VariantUID = pvs2.VariantUID AND pv2.OrgUID = pvs2.OrgUID WHERE pv2.ProductUID = ${p}.ProductUID AND pvs2.OrgUID = ${p}.OrgUID AND pv2.IsActive = 1), 0) ELSE COALESCE(${stock}.AvailableQty, 0) END`;

const SEARCH_COLUMNS = ["Products.ItemName", "Products.HSNSACCode", "Products.PartNumber"];

// Sort keys of the items list, in the order CI3 applies them
const SORT_COLUMNS: [keyof ProductListFilterDto, string][] = [
  ["NameSorting", "Products.ItemName"],
  ["StatusSorting", "Products.IsActive"],
  ["CategorySorting", "Category.Name"],
  ["QtySorting", "ProductStock.AvailableQty"],
  ["MRPSorting", "Products.MRP"],
  ["SellingPriceSorting", "Products.SellingPrice"],
  ["PurchasePriceSorting", "Products.PurchasePrice"],
];

// Columns cached per product for the CI3 transaction forms (CI3 getProductsForCache / getProductForCache)
const CACHE_COLUMNS = [
  "p.ProductUID as ProductUID",
  "p.ItemName as ItemName",
  "p.ProductType as ProductType",
  "p.CategoryUID as CategoryUID",
  "cat.Name as CategoryName",
  "p.HSNSACCode as HSNSACCode",
  "p.PartNumber as PartNumber",
  "p.SKU as SKU",
  "p.Description as Description",
  "p.PrimaryUnitUID as PrimaryUnitUID",
  "pu.ShortName as PrimaryUnitName",
  "p.MRP as MRP",
  "p.SellingPrice as SellingPrice",
  "p.PurchasePrice as PurchasePrice",
  "p.SellingProductTaxUID as SellingProductTaxUID",
  "p.PurchasePriceProductTaxUID as PurchasePriceProductTaxUID",
  "p.TaxDetailsUID as TaxDetailsUID",
  "p.TaxPercentage as TaxPercentage",
  "p.CGST as CGST",
  "p.SGST as SGST",
  "p.IGST as IGST",
  "p.Discount as Discount",
  "p.DiscountTypeUID as DiscountTypeUID",
  "p.LowStockAlertAt as LowStockAlertAt",
  "p.NotForSale as NotForSale",
  "p.IsComboItem as IsComboItem",
  "p.IsComposite as IsComposite",
  "p.IsSerialTracked as IsSerialTracked",
  "p.IsBrandApplicable as IsBrandApplicable",
  "p.IsSizeApplicable as IsSizeApplicable",
];

export interface VariantInput {
  brandUID: number;
  sizeUID: number;
  partNumber: string;
  purchasePrice: number;
  purchaseTaxUID: number;
  sellingPrice: number;
  sellingTaxUID: number;
}

// Product (item / combo) queries and writes (CI3 Products_model and the product parts of Dbwrite_ext_model).
@Injectable()
export class ProductsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getProductListPaginated — Items (IsComposite 0) or Groups (1) tab, with each row's image gallery.
  async listPaginated(orgUID: number, pageNo: number, limit: number, isComposite: number, filter: ProductListFilterDto, langCode: string) {
    const countRow = await this.applyFilters(this.read("Products.ProductTbl as Products").count({ cnt: "*" }), orgUID, isComposite, filter).first();
    const totalCount = toInt(countRow?.cnt);

    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.ProductTbl as Products")
      .select(
        "Products.ProductUID as ProductUID",
        this.langColumn(useLang, "PL.ItemName", "Products.ItemName", "ItemName"),
        "Products.ProductType as ProductType",
        this.langColumn(useLang, "CLang.Name", "Category.Name", "CategoryName"),
        "Products.SellingPrice as SellingPrice",
        "Products.MRP as MRP",
        "Products.PurchasePrice as PurchasePrice",
        "Products.HSNSACCode as HSNSACCode",
        "Products.PartNumber as PartNumber",
        "Products.IsComposite as IsComposite",
        "Products.IsBrandApplicable as IsBrandApplicable",
        "Products.IsSizeApplicable as IsSizeApplicable",
        "Products.LowStockAlertAt as LowStockAlertAt",
        this.read.raw(`${availableQty("Products", "ProductStock")} AS AvailableQuantity`),
        "Products.UpdatedOn as UpdatedOn",
        "Products.IsActive as IsActive",
        this.read.raw("CONCAT(??, ' ', ??) AS ??", ["User.FirstName", "User.LastName", "UpdatedBy"]),
        "Products.TaxPercentage as TaxPercentage",
        "SelTaxType.Name as SellingTaxType",
        "PurTaxType.Name as PurchaseTaxType",
        "puid.ShortName as PUShortName"
      )
      .leftJoin("Products.CategoryTbl as Category", "Category.CategoryUID", "Products.CategoryUID")
      .leftJoin("Products.ProductStockTbl as ProductStock", "ProductStock.ProductUID", "Products.ProductUID")
      .leftJoin("Global.ProductTaxTbl as SelTaxType", "SelTaxType.ProductTaxUID", "Products.SellingProductTaxUID")
      .leftJoin("Global.ProductTaxTbl as PurTaxType", "PurTaxType.ProductTaxUID", "Products.PurchasePriceProductTaxUID")
      .leftJoin("Global.PrimaryUnitTbl as puid", "puid.PrimaryUnitUID", "Products.PrimaryUnitUID")
      .leftJoin("Users.UserTbl as User", "User.UserUID", "Products.UpdatedBy");
    if (useLang) {
      query
        .leftJoin("Products.ProductTbl_Lang as PL", (on) => {
          on.on("PL.ProductUID", "Products.ProductUID").andOnVal("PL.LangCode", "=", langCode);
        })
        .leftJoin("Products.CategoryTbl_Lang as CLang", (on) => {
          on.on("CLang.CategoryUID", "Category.CategoryUID").andOnVal("CLang.LangCode", "=", langCode);
        });
    }
    this.applyFilters(query, orgUID, isComposite, filter);
    const sorts = SORT_COLUMNS.filter(([key]) => filter[key] !== undefined);
    if (sorts.length > 0) for (const [key, column] of sorts) query.orderBy(column, Number(filter[key]) === 1 ? "asc" : "desc");
    else query.orderBy("Products.ProductUID", "desc");
    query.limit(limit).offset(BaseRepository.offset(pageNo, limit));

    const rows: Row[] = await query;
    return { rows, totalCount };
  }

  // getProductUIDsByFilter — every item (not combo) the items filter matches (bulk "select all")
  async findUIDsByFilter(orgUID: number, filter: ProductListFilterDto): Promise<number[]> {
    const rows: { ProductUID: string }[] = await this.applyFilters(
      this.read("Products.ProductTbl as Products").select("Products.ProductUID as ProductUID"),
      orgUID,
      0,
      filter
    );
    return rows.map((row) => toInt(row.ProductUID));
  }

  // getProductsDetails — one active product of the organisation (optionally only a combo)
  async findDetail(orgUID: number, productUID: number, langCode: string, compositeOnly = false): Promise<Row | null> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.ProductTbl as Products")
      .select(
        "Products.ProductUID as ProductUID",
        "Products.OrgUID as OrgUID",
        this.langColumn(useLang, "PL.ItemName", "Products.ItemName", "ItemName"),
        this.langColumn(useLang, "CL.Name", "Category.Name", "CategoryName"),
        "Products.ProductType as ProductType",
        "Products.MRP as MRP",
        "Products.SellingPrice as SellingPrice",
        "Products.SellingProductTaxUID as SellingProductTaxUID",
        "Products.TaxDetailsUID as TaxDetailsUID",
        "Products.TaxPercentage as TaxPercentage",
        "Products.CGST as CGST",
        "Products.SGST as SGST",
        "Products.IGST as IGST",
        "Products.PrimaryUnitUID as PrimaryUnitUID",
        "Products.CategoryUID as CategoryUID",
        "Products.StorageUID as StorageUID",
        "Products.HSNSACCode as HSNSACCode",
        "Products.PurchasePrice as PurchasePrice",
        "Products.PurchasePriceProductTaxUID as PurchasePriceProductTaxUID",
        "Products.PartNumber as PartNumber",
        "Products.SKU as SKU",
        "Products.Description as Description",
        "Products.OpeningQuantity as OpeningQuantity",
        this.read.raw(`${availableQty("Products", "ProductStock")} AS AvailableQuantity`),
        "Products.OpeningPurchasePrice as OpeningPurchasePrice",
        "Products.OpeningStockValue as OpeningStockValue",
        "Products.Discount as Discount",
        "Products.DiscountTypeUID as DiscountTypeUID",
        "Products.LowStockAlertAt as LowStockAlertAt",
        "Products.NotForSale as NotForSale",
        "Products.IsRentable as IsRentable",
        "Products.IsSizeApplicable as IsSizeApplicable",
        "Products.IsComboItem as IsComboItem",
        "Products.IsComposite as IsComposite",
        "Products.IsBrandApplicable as IsBrandApplicable",
        "Products.IsSerialTracked as IsSerialTracked",
        "Products.CreatedOn as CreatedOn",
        "Products.UpdatedOn as UpdatedOn"
      )
      .leftJoin("Products.CategoryTbl as Category", "Category.CategoryUID", "Products.CategoryUID")
      .leftJoin("Products.ProductStockTbl as ProductStock", "ProductStock.ProductUID", "Products.ProductUID")
      .where({ "Products.ProductUID": productUID, "Products.OrgUID": orgUID, "Products.IsDeleted": 0, "Products.IsActive": 1 });
    if (compositeOnly) query.where("Products.IsComposite", 1);
    if (useLang) {
      query
        .leftJoin("Products.ProductTbl_Lang as PL", (on) => {
          on.on("PL.ProductUID", "Products.ProductUID").andOnVal("PL.LangCode", "=", langCode);
        })
        .leftJoin("Products.CategoryTbl_Lang as CL", (on) => {
          on.on("CL.CategoryUID", "Category.CategoryUID").andOnVal("CL.LangCode", "=", langCode);
        });
    }
    const row = await query.first();
    return row ?? null;
  }

  // Any active product in these categories (category delete check)
  async hasProductsInCategories(orgUID: number, categoryUIDs: number[]): Promise<boolean> {
    const row = await this.read("Products.ProductTbl")
      .select("ProductUID")
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .whereIn("CategoryUID", categoryUIDs)
      .first();
    return !!row;
  }

  // getProductBOM — a combo's components with their prices
  async findBOM(parentUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.ProductBOMTbl as Comp")
      .select(
        "Comp.ComponentUID as ComponentUID",
        "Comp.ChildProductUID as ChildProductUID",
        this.langColumn(useLang, "PL.ItemName", "Prod.ItemName", "ItemName"),
        "Comp.Quantity as Quantity",
        "Prod.MRP as MRP",
        "Prod.SellingPrice as SellingPrice",
        "Prod.PurchasePrice as PurchasePrice",
        "Prod.TaxPercentage as TaxPercentage"
      )
      .leftJoin("Products.ProductTbl as Prod", "Prod.ProductUID", "Comp.ChildProductUID")
      .where({ "Comp.ParentProductUID": parentUID, "Comp.IsDeleted": 0, "Comp.IsActive": 1 });
    if (useLang) {
      query.leftJoin("Products.ProductTbl_Lang as PL", (on) => {
        on.on("PL.ProductUID", "Comp.ChildProductUID").andOnVal("PL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getItemsForBOM — up to 50 active items (not combos) whose name matches
  async itemsForBOM(orgUID: number, search: string, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.ProductTbl as Products")
      .select("Products.ProductUID as ProductUID", this.langColumn(useLang, "PL.ItemName", "Products.ItemName", "ItemName"))
      .where({ "Products.IsDeleted": 0, "Products.IsActive": 1, "Products.OrgUID": orgUID, "Products.IsComposite": 0 })
      .orderBy("Products.ItemName", "asc")
      .limit(50);
    if (search) query.where("Products.ItemName", "like", BaseRepository.likePattern(search));
    if (useLang) {
      query.leftJoin("Products.ProductTbl_Lang as PL", (on) => {
        on.on("PL.ProductUID", "Products.ProductUID").andOnVal("PL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getProductsByCategoryUID
  async findByCategory(orgUID: number, categoryUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.ProductTbl as Products")
      .select(
        "Products.ProductUID as ProductUID",
        this.langColumn(useLang, "PL.ItemName", "Products.ItemName", "ItemName"),
        "Products.SellingPrice as SellingPrice",
        "Products.MRP as MRP",
        "Products.PurchasePrice as PurchasePrice",
        this.read.raw(`${availableQty("Products", "ProductStock")} AS AvailableQuantity`),
        "Products.ProductType as ProductType",
        "Products.IsComposite as IsComposite"
      )
      .leftJoin("Products.ProductStockTbl as ProductStock", "ProductStock.ProductUID", "Products.ProductUID")
      .where({ "Products.CategoryUID": categoryUID, "Products.OrgUID": orgUID, "Products.IsDeleted": 0, "Products.IsActive": 1 })
      .orderBy("Products.ItemName", "asc");
    if (useLang) {
      query.leftJoin("Products.ProductTbl_Lang as PL", (on) => {
        on.on("PL.ProductUID", "Products.ProductUID").andOnVal("PL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getProductStats — list page counters (dates YYYY-MM-DD, UTC like CI3's date())
  async stats(orgUID: number, period: { monthStart: string; fyStart: string; sevenDaysAgo: string }): Promise<Row | null> {
    const raw = (sql: string, bindings: (string | number)[] = []) => this.read.raw(sql, bindings);
    const physicalActive = "Products.ProductType = 'Product' AND Products.IsComposite = 0 AND Products.IsActive = 1";
    const row = await this.read("Products.ProductTbl as Products")
      .select(
        raw("COUNT(*) AS TotalProducts"),
        raw("SUM(CASE WHEN Products.IsActive = 1 THEN 1 ELSE 0 END) AS ActiveCount"),
        raw("SUM(CASE WHEN Products.IsActive = 0 THEN 1 ELSE 0 END) AS InActiveCount"),
        raw(`SUM(CASE WHEN ${physicalActive} THEN COALESCE(ProductStock.AvailableQty, 0) * Products.PurchasePrice ELSE 0 END) AS TotalStockValue`),
        raw("SUM(CASE WHEN Products.CreatedOn >= ? AND Products.IsActive = 1 THEN 1 ELSE 0 END) AS AddedThisMonth", [period.monthStart]),
        raw("SUM(CASE WHEN Products.CreatedOn >= ? AND Products.IsActive = 1 THEN 1 ELSE 0 END) AS AddedThisFY", [period.fyStart]),
        raw("SUM(CASE WHEN Products.UpdatedOn >= ? AND Products.IsActive = 1 THEN 1 ELSE 0 END) AS RecentlyUpdated", [period.sevenDaysAgo]),
        raw(
          `SUM(CASE WHEN Products.LowStockAlertAt > 0 AND COALESCE(ProductStock.AvailableQty, 0) <= Products.LowStockAlertAt AND COALESCE(ProductStock.AvailableQty, 0) > 0 AND ${physicalActive} THEN 1 ELSE 0 END) AS LowStockItems`
        ),
        raw("SUM(CASE WHEN Products.NotForSale = 'Yes' AND Products.IsActive = 1 THEN 1 ELSE 0 END) AS NotForSale")
      )
      .leftJoin("Products.ProductStockTbl as ProductStock", "ProductStock.ProductUID", "Products.ProductUID")
      .where({ "Products.IsDeleted": 0, "Products.OrgUID": orgUID })
      .first();
    return row ?? null;
  }

  // getRentalConfig
  async findRentalConfig(orgUID: number, productUID: number): Promise<Row | null> {
    const row = await this.read("Products.ProductRentalConfigTbl")
      .select(
        "RentalConfigUID",
        "ProductUID",
        "OrgUID",
        "SecurityDeposit",
        "HourlyRate",
        "HalfDayRate",
        "FullDayRate",
        "FixedPackageRate",
        "ExtraHourRate",
        "LateReturnChargePerHour",
        "DamagePenaltyRate",
        "MinRentalHours",
        "IsActive",
        "IsDeleted",
        "CreatedBy",
        "UpdatedBy",
        "CreatedOn",
        "UpdatedOn"
      )
      .where({ ProductUID: productUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getProductsForCache (productUID 0) / getProductForCache — rows cached for the transaction forms
  async findForCache(orgUID: number, productUID = 0): Promise<Row[]> {
    const query = this.read("Products.ProductTbl as p")
      .select(...CACHE_COLUMNS, this.read.raw(`${availableQty("p", "ps")} AS AvailableQuantity`))
      .leftJoin("Products.CategoryTbl as cat", "cat.CategoryUID", "p.CategoryUID")
      .leftJoin("Global.PrimaryUnitTbl as pu", "pu.PrimaryUnitUID", "p.PrimaryUnitUID")
      .leftJoin("Products.ProductStockTbl as ps", "ps.ProductUID", "p.ProductUID")
      .where({ "p.OrgUID": orgUID, "p.IsDeleted": 0 })
      .orderBy("p.ProductUID", "asc");
    // The full rebuild takes active products only; a single refresh takes the product whatever its status (as CI3)
    if (productUID > 0) query.where("p.ProductUID", productUID);
    else query.where("p.IsActive", 1);
    return query;
  }

  // getAllProductBOMsForSync — components of every active combo
  async allBOMsForSync(orgUID: number): Promise<Row[]> {
    return this.read("Products.ProductBOMTbl as Comp")
      .select("Comp.ParentProductUID as ParentProductUID", "Comp.ChildProductUID as ChildProductUID", "Comp.Quantity as Quantity")
      .join("Products.ProductTbl as p", "p.ProductUID", "Comp.ParentProductUID")
      .where({ "p.OrgUID": orgUID, "p.IsDeleted": 0, "p.IsActive": 1, "Comp.IsDeleted": 0, "Comp.IsActive": 1 });
  }

  // productHasTransactions — on any active transaction line
  async hasTransactions(productUID: number): Promise<boolean> {
    return !!(await this.read("Transaction.TransProductsTbl").select("TransProdUID").where({ ProductUID: productUID, IsDeleted: 0 }).first());
  }

  // productUsedInComboWithTransactions — a component of a combo that has transaction lines
  async usedInComboWithTransactions(productUID: number): Promise<boolean> {
    const row = await this.read("Transaction.TransProductsTbl as t")
      .select("t.TransProdUID")
      .join("Products.ProductBOMTbl as b", "b.ParentProductUID", "t.ProductUID")
      .where({ "b.ChildProductUID": productUID, "b.IsDeleted": 0, "t.IsDeleted": 0 })
      .first();
    return !!row;
  }

  // isProductLinkedToCombo — an active component of any combo
  async isLinkedToCombo(productUID: number): Promise<boolean> {
    return !!(await this.read("Products.ProductBOMTbl").select("ChildProductUID").where({ ChildProductUID: productUID, IsDeleted: 0, IsActive: 1 }).first());
  }

  // getProductVariants — variants with stock (modal + edit form)
  async findVariants(orgUID: number, productUID: number): Promise<Row[]> {
    return this.read("Products.ProductVariantTbl as pv")
      .select(
        "pv.VariantUID as VariantUID",
        "pv.BrandUID as BrandUID",
        "pv.SizeUID as SizeUID",
        "pv.PartNumber as PartNumber",
        "pv.PurchasePrice as PurchasePrice",
        "pv.PurchaseTaxUID as PurchaseTaxUID",
        "pv.SellingPrice as SellingPrice",
        "pv.SellingTaxUID as SellingTaxUID",
        this.read.raw("COALESCE(??, '') AS ??", ["b.BrandName", "BrandName"]),
        this.read.raw("COALESCE(??, '') AS ??", ["b.BrandCode", "BrandCode"]),
        this.read.raw("COALESCE(??, '') AS ??", ["s.Name", "SizeName"]),
        this.read.raw("COALESCE(??, 0) AS ??", ["pvs.OpeningQty", "OpeningQty"]),
        this.read.raw("COALESCE(??, 0) AS ??", ["pvs.AvailableQty", "AvailableQty"])
      )
      .leftJoin("Products.BrandTbl as b", (on) => {
        on.on("b.BrandUID", "pv.BrandUID").andOnVal("pv.BrandUID", ">", 0);
      })
      .leftJoin("Products.SizeTbl as s", (on) => {
        on.on("s.SizeUID", "pv.SizeUID").andOnVal("pv.SizeUID", ">", 0);
      })
      .leftJoin("Products.ProductVariantStockTbl as pvs", (on) => {
        on.on("pvs.VariantUID", "pv.VariantUID").andOn("pvs.OrgUID", "pv.OrgUID");
      })
      .where({ "pv.ProductUID": productUID, "pv.OrgUID": orgUID, "pv.IsActive": 1 })
      .orderBy([
        { column: "s.Name", order: "asc" },
        { column: "b.BrandName", order: "asc" },
      ]);
  }

  // getUsedVariants — variants already in the stock ledger (cannot be removed)
  async findUsedVariants(orgUID: number, productUID: number): Promise<Row[]> {
    return this.read("Products.StockLedgerTbl as sl")
      .select("pv.VariantUID as VariantUID", "pv.SizeUID as SizeUID", "pv.BrandUID as BrandUID")
      .join("Products.ProductVariantTbl as pv", "pv.VariantUID", "sl.VariantUID")
      .where({ "pv.ProductUID": productUID, "pv.OrgUID": orgUID })
      .whereNotNull("sl.VariantUID")
      .groupBy("pv.VariantUID", "pv.SizeUID", "pv.BrandUID");
  }

  // getProductVariantsForPricelist (one product) / getAllProductVariantsForSync (productUID 0) — slim variants with a label
  async findVariantLabels(orgUID: number, productUID = 0) {
    const query = this.read("Products.ProductVariantTbl as pv")
      .select(
        "pv.ProductUID as ProductUID",
        "pv.VariantUID as VariantUID",
        "pv.BrandUID as BrandUID",
        "pv.SizeUID as SizeUID",
        "pv.PartNumber as PartNumber",
        "pv.SellingPrice as SellingPrice",
        "pv.SellingTaxUID as SellingTaxUID",
        this.read.raw("COALESCE(??, '') AS ??", ["b.BrandName", "BrandName"]),
        this.read.raw("COALESCE(??, '') AS ??", ["s.Name", "SizeName"])
      )
      .leftJoin("Products.BrandTbl as b", (on) => {
        on.on("b.BrandUID", "pv.BrandUID").andOnVal("pv.BrandUID", ">", 0);
      })
      .leftJoin("Products.SizeTbl as s", (on) => {
        on.on("s.SizeUID", "pv.SizeUID").andOnVal("pv.SizeUID", ">", 0);
      })
      .where({ "pv.OrgUID": orgUID, "pv.IsActive": 1 })
      .orderBy([
        { column: "pv.ProductUID", order: "asc" },
        { column: "s.Name", order: "asc" },
        { column: "b.BrandName", order: "asc" },
      ]);
    if (productUID > 0) query.where("pv.ProductUID", productUID);
    const rows: Row[] = await query;
    return rows.map((row) => {
      const parts = [row.BrandName, row.SizeName].filter((part) => part);
      return {
        ProductUID: toInt(row.ProductUID),
        VariantUID: toInt(row.VariantUID),
        BrandUID: toInt(row.BrandUID),
        SizeUID: toInt(row.SizeUID),
        PartNumber: row.PartNumber ?? "",
        SellingPrice: Number(row.SellingPrice ?? 0),
        SellingTaxUID: toInt(row.SellingTaxUID),
        BrandName: row.BrandName ?? "",
        SizeName: row.SizeName ?? "",
        Label: parts.length > 0 ? parts.join(" / ") : `Variant #${toInt(row.VariantUID)}`,
      };
    });
  }

  // getProductTypeAndOpeningQty
  async findTypeAndOpeningQty(orgUID: number, productUID: number): Promise<Row | null> {
    const row = await this.read("Products.ProductTbl").select("OpeningQuantity", "ProductType").where({ ProductUID: productUID, OrgUID: orgUID }).first();
    return row ?? null;
  }

  // getAvailableSerialNumbers
  async availableSerials(orgUID: number, productUID: number): Promise<string[]> {
    const rows: { SerialNumber: string }[] = await this.read("Transaction.ProductSerialsTbl")
      .select("SerialNumber")
      .where({ OrgUID: orgUID, ProductUID: productUID, Status: "Available", IsDeleted: 0 })
      .orderBy("SerialNumber", "asc");
    return rows.map((row) => row.SerialNumber);
  }

  // getProductStockData (one product) / getAllProductsStockData (productUID 0) — opening quantity and ledger IN / OUT
  async stockData(orgUID: number, productUID = 0): Promise<{ ProductUID: number; OpeningQty: number; SumIn: number; SumOut: number }[]> {
    const query = this.read("Products.ProductTbl as p")
      .select(
        "p.ProductUID as ProductUID",
        this.read.raw("COALESCE(??, 0) AS ??", ["p.OpeningQuantity", "OpeningQty"]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'IN' THEN ?? ELSE 0 END), 0) AS ??", ["sl.MovementType", "sl.Quantity", "SumIn"]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'OUT' THEN ?? ELSE 0 END), 0) AS ??", ["sl.MovementType", "sl.Quantity", "SumOut"])
      )
      .leftJoin("Products.StockLedgerTbl as sl", (on) => {
        on.on("sl.ProductUID", "p.ProductUID").andOn("sl.OrgUID", "p.OrgUID").andOnVal("sl.IsDeleted", "=", 0);
      })
      .where({ "p.OrgUID": orgUID, "p.IsDeleted": 0 })
      .groupBy("p.ProductUID", "p.OpeningQuantity");
    if (productUID > 0) query.where("p.ProductUID", productUID);
    const rows: Row[] = await query;
    return rows.map((row) => ({ ProductUID: toInt(row.ProductUID), OpeningQty: Number(row.OpeningQty), SumIn: Number(row.SumIn), SumOut: Number(row.SumOut) }));
  }

  // getTaxPercentageDetailsInfo — one tax rate (Global.TaxDetailsTbl)
  async findTaxDetail(taxDetailsUID: number): Promise<Row | null> {
    if (!taxDetailsUID) return null;
    const row = await this.read("Global.TaxDetailsTbl")
      .select("TaxDetailsUID", "TaxName", "Percentage", "CGST", "SGST", "IGST")
      .where({ TaxDetailsUID: taxDetailsUID, IsDeleted: 0, IsActive: 1 })
      .first();
    return row ?? null;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async insertProduct(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number> {
    const [productUID] = await trx("Products.ProductTbl").insert(row);
    return productUID;
  }

  async updateProduct(orgUID: number, productUIDs: number[], data: Record<string, unknown>, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)("Products.ProductTbl").where({ OrgUID: orgUID }).whereIn("ProductUID", productUIDs).update(data);
  }

  // _saveRentalConfig — one config row per product
  async saveRentalConfig(trx: Knex.Transaction, orgUID: number, productUID: number, config: Record<string, unknown>, userUID: number): Promise<void> {
    const existing = await trx("Products.ProductRentalConfigTbl").select("RentalConfigUID").where({ ProductUID: productUID, OrgUID: orgUID, IsDeleted: 0 }).first();
    if (existing) {
      await trx("Products.ProductRentalConfigTbl").where({ ProductUID: productUID, OrgUID: orgUID, IsDeleted: 0 }).update(config);
    } else {
      await trx("Products.ProductRentalConfigTbl").insert({ ...config, ProductUID: productUID, OrgUID: orgUID, IsActive: 1, IsDeleted: 0, CreatedBy: userUID });
    }
  }

  // saveProductBOM — replaces the combo's components
  async replaceBOM(trx: Knex.Transaction, orgUID: number, parentUID: number, components: { childUID: number; qty: number }[], userUID: number): Promise<void> {
    await this.softDeleteBOM(trx, parentUID, userUID);
    if (components.length > 0) {
      await trx("Products.ProductBOMTbl").insert(
        components.map((component) => ({
          OrgUID: orgUID,
          ParentProductUID: parentUID,
          ChildProductUID: component.childUID,
          Quantity: component.qty,
          CreatedBy: userUID,
          UpdatedBy: userUID,
        }))
      );
    }
  }

  async softDeleteBOM(trx: Knex.Transaction, parentUID: number, userUID: number): Promise<void> {
    await trx("Products.ProductBOMTbl").where({ ParentProductUID: parentUID }).update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID });
  }

  // initProductStock
  async initStock(trx: Knex.Transaction, orgUID: number, productUID: number, quantity: number): Promise<void> {
    await trx("Products.ProductStockTbl").insert({ ProductUID: productUID, OrgUID: orgUID, AvailableQty: quantity });
  }

  // applyOpeningQtyDelta — stock moves by the change in opening quantity
  async applyStockDelta(trx: Knex.Transaction, orgUID: number, productUID: number, delta: number): Promise<void> {
    if (delta === 0) return;
    await trx("Products.ProductStockTbl")
      .where({ ProductUID: productUID, OrgUID: orgUID })
      .update({ AvailableQty: trx.raw("CAST(AvailableQty AS SIGNED) + ?", [delta]) });
  }

  async setAvailableQty(orgUID: number, productUID: number, quantity: number): Promise<void> {
    await this.writer()("Products.ProductStockTbl").where({ ProductUID: productUID, OrgUID: orgUID }).update({ AvailableQty: quantity });
  }

  // upsertProductVariant — one variant per product + brand + size; returns its VariantUID
  async upsertVariant(trx: Knex.Transaction, orgUID: number, productUID: number, variant: VariantInput, userUID: number): Promise<number> {
    await trx.raw(
      `INSERT INTO Products.ProductVariantTbl
         (ProductUID, OrgUID, BrandUID, SizeUID, PartNumber, PurchasePrice, PurchaseTaxUID, SellingPrice, SellingTaxUID, UpdatedBy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         VariantUID = LAST_INSERT_ID(VariantUID), PartNumber = VALUES(PartNumber), PurchasePrice = VALUES(PurchasePrice),
         PurchaseTaxUID = VALUES(PurchaseTaxUID), SellingPrice = VALUES(SellingPrice), SellingTaxUID = VALUES(SellingTaxUID),
         UpdatedBy = VALUES(UpdatedBy)`,
      [
        productUID,
        orgUID,
        variant.brandUID,
        variant.sizeUID,
        variant.partNumber,
        variant.purchasePrice,
        variant.purchaseTaxUID,
        variant.sellingPrice,
        variant.sellingTaxUID,
        userUID,
      ]
    );
    const result = await trx.raw("SELECT LAST_INSERT_ID() AS id");
    return toInt(result[0][0]?.id);
  }

  // upsertVariantStock — a changed opening quantity moves the available quantity by the same amount
  async upsertVariantStock(trx: Knex.Transaction, orgUID: number, variantUID: number, openingQty: number): Promise<void> {
    await trx.raw(
      `INSERT INTO Products.ProductVariantStockTbl (VariantUID, OrgUID, OpeningQty, AvailableQty)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE AvailableQty = AvailableQty + (VALUES(OpeningQty) - OpeningQty), OpeningQty = VALUES(OpeningQty)`,
      [variantUID, orgUID, openingQty, openingQty]
    );
  }

  // syncVariantStockTotal — product stock = sum of its variants' stock
  async syncVariantStockTotal(trx: Knex.Transaction, orgUID: number, productUID: number): Promise<void> {
    await trx.raw(
      `UPDATE Products.ProductStockTbl pst
       SET pst.AvailableQty = (
         SELECT COALESCE(SUM(pvs.AvailableQty), 0) FROM Products.ProductVariantTbl pv
         JOIN Products.ProductVariantStockTbl pvs ON pvs.VariantUID = pv.VariantUID AND pvs.OrgUID = pst.OrgUID
         WHERE pv.ProductUID = ? AND pv.OrgUID = ?
       )
       WHERE pst.ProductUID = ? AND pst.OrgUID = ?`,
      [productUID, orgUID, productUID, orgUID]
    );
  }

  // saveProdLangRow — translated item name and description
  async saveLangRow(productUID: number, langCode: string, text: { ItemName: string | null; Description: string | null }, userUID: number): Promise<void> {
    await this.writer()("Products.ProductTbl_Lang")
      .insert({ ProductUID: productUID, LangCode: langCode, ...text, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["ProductUID", "LangCode"])
      .merge(["ItemName", "Description", "UpdatedBy"]);
  }

  // Shared by the count and the data query (CI3 itemFilterFormation, with bound values instead of string SQL)
  private applyFilters(query: Knex.QueryBuilder, orgUID: number, isComposite: number, filter: ProductListFilterDto): Knex.QueryBuilder {
    query.where({ "Products.IsDeleted": 0, "Products.OrgUID": orgUID, "Products.IsComposite": isComposite });
    if (filter.SearchAllData !== undefined) this.whereAnyLike(query, SEARCH_COLUMNS, filter.SearchAllData);
    if (filter.ProductType) query.whereIn("Products.ProductType", filter.ProductType.length ? filter.ProductType : [""]);
    if (filter.Category) query.whereIn("Products.CategoryUID", filter.Category.length ? filter.Category : [0]);
    if (filter.Storage) query.whereIn("Products.StorageUID", filter.Storage.length ? filter.Storage : [0]);
    if (filter.StatusFilter) query.whereIn("Products.IsActive", filter.StatusFilter.length ? filter.StatusFilter : [-1]);
    if (filter.Tax) query.whereIn("Products.TaxDetailsUID", filter.Tax.length ? filter.Tax : [0]);
    const updatedBy = (filter.LastUpdatedFilter ?? []).filter((uid) => uid > 0);
    if (updatedBy.length > 0) query.whereIn("Products.UpdatedBy", updatedBy);
    return query;
  }
}
