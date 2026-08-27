import { Injectable } from "@nestjs/common";
import { RowDataPacket, ResultSetHeader } from "mysql2";
import crypto from "crypto";
import { mysqlReadPool, mysqlWritePool } from "../config/mysql";

const ASSET_BASE_URL = process.env.ASSET_BASE_URL || "";

function toImageUrl(filePath: string | null): string | null {
  if (!filePath) return null;
  return `${ASSET_BASE_URL}${filePath}`;
}

export interface ProductVariant {
  variantUID: number;
  brandUID: number;
  brand: string | null;
  sizeUID: number;
  size: string | null;
  partNumber: string;
  price: number;
}

export interface ProductListItem {
  productUID: number;
  name: string;
  description: string;
  category: string | null;
  categoryUID: number | null;
  priceFrom: number;
  priceTo: number;
  hasVariants: boolean;
  stock: number;
  imageUrl: string | null;
}

export interface ProductDetail extends ProductListItem {
  mrp: number;
  basePrice: number;
  variants: ProductVariant[];
  images: string[];
}

interface ProductFilters {
  category?: string;
  search?: string;
  brand?: string;
  minPrice?: number;
  maxPrice?: number;
  sort?: string;
}

const SORT_COLUMNS: Record<string, string> = {
  newest: "createdOn DESC",
  price_asc: "effectivePrice ASC",
  price_desc: "effectivePrice DESC",
  name_asc: "name ASC",
};

const BASE_SELECT = `
  SELECT
    p.ProductUID AS productUID,
    p.ItemName AS name,
    p.Description AS description,
    p.SellingPrice AS basePrice,
    p.MRP AS mrp,
    p.CategoryUID AS categoryUID,
    c.Name AS category,
    p.CreatedOn AS createdOn,
    COALESCE(s.AvailableQty, 0) AS stock,
    (SELECT MIN(v.SellingPrice) FROM ProductVariantTbl v
       WHERE v.ProductUID = p.ProductUID AND v.OrgUID = p.OrgUID AND v.IsDeleted = 0 AND v.IsActive = 1) AS variantMinPrice,
    (SELECT MAX(v.SellingPrice) FROM ProductVariantTbl v
       WHERE v.ProductUID = p.ProductUID AND v.OrgUID = p.OrgUID AND v.IsDeleted = 0 AND v.IsActive = 1) AS variantMaxPrice,
    (SELECT ea.FilePath FROM EntityAttachmentsTbl ea
       WHERE ea.EntityType = 'Product' AND ea.EntityUID = p.ProductUID AND ea.OrgUID = p.OrgUID
         AND ea.IsDeleted = 0 AND ea.IsActive = 1
       ORDER BY ea.SortOrder ASC LIMIT 1) AS imagePath
  FROM ProductTbl p
  LEFT JOIN CategoryTbl c ON c.CategoryUID = p.CategoryUID AND c.OrgUID = p.OrgUID
  LEFT JOIN ProductStockTbl s ON s.ProductUID = p.ProductUID AND s.OrgUID = p.OrgUID
`;

function mapRow(row: RowDataPacket): ProductListItem & { basePrice: number; mrp: number } {
  const hasVariants = row.variantMinPrice !== null;
  return {
    productUID: row.productUID,
    name: row.name,
    description: row.description || "",
    category: row.category,
    categoryUID: row.categoryUID,
    priceFrom: hasVariants ? row.variantMinPrice : row.basePrice,
    priceTo: hasVariants ? row.variantMaxPrice : row.basePrice,
    hasVariants,
    stock: row.stock,
    imageUrl: toImageUrl(row.imagePath),
    basePrice: row.basePrice,
    mrp: row.mrp,
  };
}

export interface CreateProductInput {
  name: string;
  description?: string;
  price: number;
  mrp?: number;
  stock: number;
  categoryUID?: number;
}

export interface UpdateProductInput {
  name?: string;
  description?: string;
  price?: number;
  mrp?: number;
  stock?: number;
  categoryUID?: number;
}

export interface ProductFullVariant {
  variantUID: number;
  brandUID: number;
  brand: string | null;
  sizeUID: number;
  size: string | null;
  sizeCode: string | null;
  sizeDescription: string | null;
  partNumber: string;
  purchasePrice: number;
  purchaseTaxUID: number;
  sellingPrice: number;
  sellingTaxUID: number;
  isActive: boolean;
  isDeleted: boolean;
  openingQty: number;
  availableQty: number;
  createdOn: Date;
  updatedOn: Date;
}

export interface ProductBrandStock {
  brandUID: number;
  brand: string | null;
  openingQty: number;
  availableQty: number;
  updatedOn: Date;
}

export interface ProductImage {
  attachUID: number;
  fileName: string;
  filePath: string;
  imageUrl: string | null;
  fileSize: number;
  sortOrder: number;
  isActive: boolean;
  createdOn: Date;
  updatedOn: Date;
}

export interface ProductFullDetail {
  productUID: number;
  orgUID: number;
  prodToken: string;
  name: string;
  productType: string;
  unitPrice: number;
  mrp: number;
  sellingPrice: number;
  sellingProductTaxUID: number;
  sellingProductTaxName: string | null;
  taxDetailsUID: number;
  taxName: string | null;
  taxDisplayName: string | null;
  taxPercentage: number;
  cgst: number;
  sgst: number;
  igst: number;
  primaryUnitUID: number | null;
  primaryUnitName: string | null;
  primaryUnitShortName: string | null;
  categoryUID: number | null;
  category: string | null;
  storageUID: number | null;
  storage: string | null;
  hsnSacCode: string | null;
  purchasePrice: number;
  purchasePriceProductTaxUID: number;
  purchasePriceProductTaxName: string | null;
  partNumber: string | null;
  sku: string | null;
  description: string;
  openingQuantity: number;
  openingPurchasePrice: number;
  openingStockValue: number;
  discount: number;
  discountTypeUID: number;
  discountTypeName: string | null;
  discountTypeSymbol: string | null;
  lowStockAlertAt: number;
  notForSale: string;
  isRentable: boolean;
  isSizeApplicable: boolean;
  isComboItem: boolean;
  isComposite: boolean;
  isBrandApplicable: boolean;
  isSerialTracked: boolean;
  isActive: boolean;
  isDeleted: boolean;
  createdBy: number;
  updatedBy: number;
  createdOn: Date;
  updatedOn: Date;
  stock: number;
  variants: ProductFullVariant[];
  brandStock: ProductBrandStock[];
  images: ProductImage[];
}

const FULL_SELECT = `
  SELECT
    p.ProductUID AS productUID, p.OrgUID AS orgUID, p.ProdToken AS prodToken,
    p.ItemName AS name, p.ProductType AS productType,
    p.UnitPrice AS unitPrice, p.MRP AS mrp, p.SellingPrice AS sellingPrice,
    p.SellingProductTaxUID AS sellingProductTaxUID, pt1.Name AS sellingProductTaxName,
    p.TaxDetailsUID AS taxDetailsUID, td.TaxName AS taxName, td.DisplayName AS taxDisplayName,
    p.TaxPercentage AS taxPercentage, p.CGST AS cgst, p.SGST AS sgst, p.IGST AS igst,
    p.PrimaryUnitUID AS primaryUnitUID, pu.Name AS primaryUnitName, pu.ShortName AS primaryUnitShortName,
    p.CategoryUID AS categoryUID, c.Name AS category,
    p.StorageUID AS storageUID, st.Name AS storage,
    p.HSNSACCode AS hsnSacCode,
    p.PurchasePrice AS purchasePrice,
    p.PurchasePriceProductTaxUID AS purchasePriceProductTaxUID, pt2.Name AS purchasePriceProductTaxName,
    p.PartNumber AS partNumber, p.SKU AS sku, p.Description AS description,
    p.OpeningQuantity AS openingQuantity, p.OpeningPurchasePrice AS openingPurchasePrice,
    p.OpeningStockValue AS openingStockValue,
    p.Discount AS discount, p.DiscountTypeUID AS discountTypeUID,
    dt.DisplayName AS discountTypeName, dt.Symbol AS discountTypeSymbol,
    p.LowStockAlertAt AS lowStockAlertAt, p.NotForSale AS notForSale,
    p.IsRentable AS isRentable, p.IsSizeApplicable AS isSizeApplicable,
    p.IsComboItem AS isComboItem, p.IsComposite AS isComposite,
    p.IsBrandApplicable AS isBrandApplicable, p.IsSerialTracked AS isSerialTracked,
    p.IsActive AS isActive, p.IsDeleted AS isDeleted,
    p.CreatedBy AS createdBy, p.UpdatedBy AS updatedBy, p.CreatedOn AS createdOn, p.UpdatedOn AS updatedOn,
    COALESCE(s.AvailableQty, 0) AS stock
  FROM ProductTbl p
  LEFT JOIN CategoryTbl c ON c.CategoryUID = p.CategoryUID AND c.OrgUID = p.OrgUID
  LEFT JOIN StorageTbl st ON st.StorageUID = p.StorageUID
  LEFT JOIN ProductStockTbl s ON s.ProductUID = p.ProductUID AND s.OrgUID = p.OrgUID
  LEFT JOIN Global.TaxDetailsTbl td ON td.TaxDetailsUID = p.TaxDetailsUID
  LEFT JOIN Global.PrimaryUnitTbl pu ON pu.PrimaryUnitUID = p.PrimaryUnitUID
  LEFT JOIN Global.DiscountTypeTbl dt ON dt.DiscountTypeUID = p.DiscountTypeUID
  LEFT JOIN Global.ProductTaxTbl pt1 ON pt1.ProductTaxUID = p.SellingProductTaxUID
  LEFT JOIN Global.ProductTaxTbl pt2 ON pt2.ProductTaxUID = p.PurchasePriceProductTaxUID
  WHERE p.OrgUID = ? AND p.ProductUID = ? AND p.IsDeleted = 0
`;

@Injectable()
export class ProductsRepository {
  async listProducts(orgUID: number, filters: ProductFilters): Promise<ProductListItem[]> {
    const conditions = ["p.OrgUID = ?", "p.IsDeleted = 0", "p.IsActive = 1", "p.ProductType = 'Product'"];
    const params: unknown[] = [orgUID];

    if (filters.category) {
      conditions.push("c.Name = ?");
      params.push(filters.category);
    }
    if (filters.search) {
      conditions.push("p.ItemName LIKE ?");
      params.push(`%${filters.search}%`);
    }
    if (filters.brand) {
      conditions.push(
        `EXISTS (SELECT 1 FROM ProductVariantTbl v JOIN BrandTbl b ON b.BrandUID = v.BrandUID AND b.OrgUID = v.OrgUID
           WHERE v.ProductUID = p.ProductUID AND v.OrgUID = p.OrgUID AND v.IsDeleted = 0 AND v.IsActive = 1 AND b.BrandName = ?)`
      );
      params.push(filters.brand);
    }

    const havingConditions: string[] = [];
    const havingParams: unknown[] = [];

    if (filters.minPrice !== undefined) {
      havingConditions.push("COALESCE(t.variantMinPrice, t.basePrice) >= ?");
      havingParams.push(filters.minPrice);
    }
    if (filters.maxPrice !== undefined) {
      havingConditions.push("COALESCE(t.variantMinPrice, t.basePrice) <= ?");
      havingParams.push(filters.maxPrice);
    }

    let sql = `SELECT t.*, COALESCE(t.variantMinPrice, t.basePrice) AS effectivePrice FROM (${BASE_SELECT} WHERE ${conditions.join(" AND ")}) t`;
    if (havingConditions.length > 0) {
      sql += ` WHERE ${havingConditions.join(" AND ")}`;
    }
    const sortColumn = SORT_COLUMNS[filters.sort || "newest"] || SORT_COLUMNS.newest;
    sql += ` ORDER BY ${sortColumn}`;

    const [rows] = await mysqlReadPool.query<RowDataPacket[]>(sql, [...params, ...havingParams]);
    return rows.map(mapRow);
  }

  async listCategories(orgUID: number): Promise<{ categoryUID: number; name: string }[]> {
    const [rows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT CategoryUID AS categoryUID, Name AS name FROM CategoryTbl
       WHERE OrgUID = ? AND IsDeleted = 0 AND IsActive = 1 ORDER BY Name`,
      [orgUID]
    );
    return rows as { categoryUID: number; name: string }[];
  }

  async listBrands(orgUID: number): Promise<{ brandUID: number; name: string }[]> {
    const [rows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT DISTINCT b.BrandUID AS brandUID, b.BrandName AS name
       FROM BrandTbl b
       JOIN ProductVariantTbl v ON v.BrandUID = b.BrandUID AND v.OrgUID = b.OrgUID
       WHERE b.OrgUID = ? AND b.IsDeleted = 0 AND b.IsActive = 1 AND v.IsDeleted = 0 AND v.IsActive = 1
       ORDER BY b.BrandName`,
      [orgUID]
    );
    return rows as { brandUID: number; name: string }[];
  }

  async getProductById(orgUID: number, productUID: number): Promise<ProductDetail | null> {
    const [rows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT t.* FROM (${BASE_SELECT} WHERE p.OrgUID = ? AND p.ProductUID = ? AND p.IsDeleted = 0 AND p.IsActive = 1) t`,
      [orgUID, productUID]
    );
    if (rows.length === 0) return null;
    const base = mapRow(rows[0]);

    const [variantRows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT v.VariantUID AS variantUID, v.BrandUID AS brandUID, b.BrandName AS brand,
              v.SizeUID AS sizeUID, sz.Name AS size, v.PartNumber AS partNumber, v.SellingPrice AS price
       FROM ProductVariantTbl v
       LEFT JOIN BrandTbl b ON b.BrandUID = v.BrandUID AND b.OrgUID = v.OrgUID
       LEFT JOIN SizeTbl sz ON sz.SizeUID = v.SizeUID AND sz.OrgUID = v.OrgUID
       WHERE v.ProductUID = ? AND v.OrgUID = ? AND v.IsDeleted = 0 AND v.IsActive = 1`,
      [productUID, orgUID]
    );

    const [imageRows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT FilePath FROM EntityAttachmentsTbl
       WHERE EntityType = 'Product' AND EntityUID = ? AND OrgUID = ? AND IsDeleted = 0 AND IsActive = 1
       ORDER BY SortOrder ASC`,
      [productUID, orgUID]
    );

    return {
      ...base,
      variants: (variantRows as RowDataPacket[]).map((v) => ({
        variantUID: v.variantUID,
        brandUID: v.brandUID,
        brand: v.brand,
        sizeUID: v.sizeUID,
        size: v.size,
        partNumber: v.partNumber,
        price: v.price,
      })),
      images: (imageRows as RowDataPacket[])
        .map((i) => toImageUrl(i.FilePath))
        .filter((url): url is string => url !== null),
    };
  }

  async getVariantById(orgUID: number, productUID: number, variantUID: number): Promise<ProductVariant | null> {
    const [rows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT v.VariantUID AS variantUID, v.BrandUID AS brandUID, b.BrandName AS brand,
              v.SizeUID AS sizeUID, sz.Name AS size, v.PartNumber AS partNumber, v.SellingPrice AS price
       FROM ProductVariantTbl v
       LEFT JOIN BrandTbl b ON b.BrandUID = v.BrandUID AND b.OrgUID = v.OrgUID
       LEFT JOIN SizeTbl sz ON sz.SizeUID = v.SizeUID AND sz.OrgUID = v.OrgUID
       WHERE v.VariantUID = ? AND v.ProductUID = ? AND v.OrgUID = ? AND v.IsDeleted = 0 AND v.IsActive = 1`,
      [variantUID, productUID, orgUID]
    );
    if (rows.length === 0) return null;
    const v = rows[0];
    return {
      variantUID: v.variantUID,
      brandUID: v.brandUID,
      brand: v.brand,
      sizeUID: v.sizeUID,
      size: v.size,
      partNumber: v.partNumber,
      price: v.price,
    };
  }

  async hasActiveVariants(orgUID: number, productUID: number): Promise<boolean> {
    const [rows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT 1 FROM ProductVariantTbl WHERE ProductUID = ? AND OrgUID = ? AND IsDeleted = 0 AND IsActive = 1 LIMIT 1`,
      [productUID, orgUID]
    );
    return rows.length > 0;
  }

  async createProduct(orgUID: number, input: CreateProductInput): Promise<ProductDetail> {
    const prodToken = crypto.randomUUID();
    const [result] = await mysqlWritePool.query<ResultSetHeader>(
      `INSERT INTO ProductTbl
         (OrgUID, ProdToken, ItemName, Description, UnitPrice, SellingPrice, MRP, CategoryUID,
          TaxDetailsUID, TaxPercentage, CGST, SGST, IGST)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0, 0)`,
      [
        orgUID,
        prodToken,
        input.name,
        input.description || "",
        input.price,
        input.price,
        input.mrp || 0,
        input.categoryUID ?? null,
      ]
    );
    const productUID = result.insertId;

    await mysqlWritePool.query(`INSERT INTO ProductStockTbl (ProductUID, OrgUID, AvailableQty) VALUES (?, ?, ?)`, [
      productUID,
      orgUID,
      input.stock,
    ]);

    const created = await this.getProductById(orgUID, productUID);
    if (!created) throw new Error("Failed to load created product");
    return created;
  }

  async updateProduct(orgUID: number, productUID: number, input: UpdateProductInput): Promise<ProductDetail | null> {
    const existing = await this.getProductById(orgUID, productUID);
    if (!existing) return null;

    const setClauses: string[] = [];
    const params: unknown[] = [];
    if (input.name !== undefined) {
      setClauses.push("ItemName = ?");
      params.push(input.name);
    }
    if (input.description !== undefined) {
      setClauses.push("Description = ?");
      params.push(input.description);
    }
    if (input.price !== undefined) {
      setClauses.push("SellingPrice = ?", "UnitPrice = ?");
      params.push(input.price, input.price);
    }
    if (input.mrp !== undefined) {
      setClauses.push("MRP = ?");
      params.push(input.mrp);
    }
    if (input.categoryUID !== undefined) {
      setClauses.push("CategoryUID = ?");
      params.push(input.categoryUID);
    }

    if (setClauses.length > 0) {
      await mysqlWritePool.query(`UPDATE ProductTbl SET ${setClauses.join(", ")} WHERE ProductUID = ? AND OrgUID = ?`, [
        ...params,
        productUID,
        orgUID,
      ]);
    }

    if (input.stock !== undefined) {
      await mysqlWritePool.query(
        `INSERT INTO ProductStockTbl (ProductUID, OrgUID, AvailableQty) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE AvailableQty = VALUES(AvailableQty)`,
        [productUID, orgUID, input.stock]
      );
    }

    return this.getProductById(orgUID, productUID);
  }

  async deleteProduct(orgUID: number, productUID: number): Promise<boolean> {
    const [result] = await mysqlWritePool.query<ResultSetHeader>(
      `UPDATE ProductTbl SET IsDeleted = 1 WHERE ProductUID = ? AND OrgUID = ? AND IsDeleted = 0`,
      [productUID, orgUID]
    );
    return result.affectedRows > 0;
  }

  async decrementStock(orgUID: number, productUID: number, quantity: number): Promise<void> {
    await mysqlWritePool.query(`UPDATE ProductStockTbl SET AvailableQty = AvailableQty - ? WHERE ProductUID = ? AND OrgUID = ?`, [
      quantity,
      productUID,
      orgUID,
    ]);
  }

  async getProductFullDetail(orgUID: number, productUID: number): Promise<ProductFullDetail | null> {
    const [rows] = await mysqlReadPool.query<RowDataPacket[]>(FULL_SELECT, [orgUID, productUID]);
    if (rows.length === 0) return null;
    const p = rows[0] as ProductFullDetail;

    const [variantRows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT v.VariantUID AS variantUID, v.BrandUID AS brandUID, b.BrandName AS brand,
              v.SizeUID AS sizeUID, sz.Name AS size, sz.SizeCode AS sizeCode, sz.Description AS sizeDescription,
              v.PartNumber AS partNumber, v.PurchasePrice AS purchasePrice, v.PurchaseTaxUID AS purchaseTaxUID,
              v.SellingPrice AS sellingPrice, v.SellingTaxUID AS sellingTaxUID,
              v.IsActive AS isActive, v.IsDeleted AS isDeleted,
              COALESCE(vs.OpeningQty, 0) AS openingQty, COALESCE(vs.AvailableQty, 0) AS availableQty,
              v.CreatedOn AS createdOn, v.UpdatedOn AS updatedOn
       FROM ProductVariantTbl v
       LEFT JOIN BrandTbl b ON b.BrandUID = v.BrandUID AND b.OrgUID = v.OrgUID
       LEFT JOIN SizeTbl sz ON sz.SizeUID = v.SizeUID AND sz.OrgUID = v.OrgUID
       LEFT JOIN ProductVariantStockTbl vs ON vs.VariantUID = v.VariantUID AND vs.OrgUID = v.OrgUID
       WHERE v.ProductUID = ? AND v.OrgUID = ? AND v.IsDeleted = 0`,
      [productUID, orgUID]
    );

    const [brandStockRows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT bs.BrandUID AS brandUID, b.BrandName AS brand,
              bs.OpeningQty AS openingQty, bs.AvailableQty AS availableQty, bs.UpdatedOn AS updatedOn
       FROM ProductBrandStockTbl bs
       LEFT JOIN BrandTbl b ON b.BrandUID = bs.BrandUID AND b.OrgUID = bs.OrgUID
       WHERE bs.ProductUID = ? AND bs.OrgUID = ?`,
      [productUID, orgUID]
    );

    const [imageRows] = await mysqlReadPool.query<RowDataPacket[]>(
      `SELECT AttachUID AS attachUID, FileName AS fileName, FilePath AS filePath, FileSize AS fileSize,
              SortOrder AS sortOrder, IsActive AS isActive, CreatedOn AS createdOn, UpdatedOn AS updatedOn
       FROM EntityAttachmentsTbl
       WHERE EntityType = 'Product' AND EntityUID = ? AND OrgUID = ? AND IsDeleted = 0
       ORDER BY SortOrder ASC`,
      [productUID, orgUID]
    );

    return {
      ...p,
      variants: variantRows as unknown as ProductFullVariant[],
      brandStock: brandStockRows as unknown as ProductBrandStock[],
      images: (imageRows as RowDataPacket[]).map((row) => ({
        attachUID: row.attachUID,
        fileName: row.fileName,
        filePath: row.filePath,
        imageUrl: toImageUrl(row.filePath),
        fileSize: row.fileSize,
        sortOrder: row.sortOrder,
        isActive: row.isActive,
        createdOn: row.createdOn,
        updatedOn: row.updatedOn,
      })),
    };
  }
}
