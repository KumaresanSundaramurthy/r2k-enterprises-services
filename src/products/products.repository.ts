import { Injectable } from "@nestjs/common";
import type { Knex } from "knex";
import crypto from "crypto";
import { knexRead, knexWrite } from "../config/knex";

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

interface ProductListRow {
  productUID: number;
  name: string;
  description: string | null;
  basePrice: number;
  mrp: number;
  categoryUID: number | null;
  category: string | null;
  createdOn: Date;
  stock: number;
  variantMinPrice: number | null;
  variantMaxPrice: number | null;
  imagePath: string | null;
}

function mapRow(row: ProductListRow): ProductListItem & { basePrice: number; mrp: number } {
  const hasVariants = row.variantMinPrice !== null;
  return {
    productUID: row.productUID,
    name: row.name,
    description: row.description || "",
    category: row.category,
    categoryUID: row.categoryUID,
    priceFrom: hasVariants ? (row.variantMinPrice as number) : row.basePrice,
    priceTo: hasVariants ? (row.variantMaxPrice as number) : row.basePrice,
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

@Injectable()
export class ProductsRepository {
  private baseProductQuery() {
    return knexRead({ p: "Products.ProductTbl" })
      .select({
        productUID: "p.ProductUID",
        name: "p.ItemName",
        description: "p.Description",
        basePrice: "p.SellingPrice",
        mrp: "p.MRP",
        categoryUID: "p.CategoryUID",
        category: "c.Name",
        createdOn: "p.CreatedOn",
        stock: knexRead.raw("COALESCE(s.AvailableQty, 0)"),
        variantMinPrice: knexRead.raw(
          `(SELECT MIN(v.SellingPrice) FROM Products.ProductVariantTbl v
             WHERE v.ProductUID = p.ProductUID AND v.OrgUID = p.OrgUID AND v.IsDeleted = 0 AND v.IsActive = 1)`
        ),
        variantMaxPrice: knexRead.raw(
          `(SELECT MAX(v.SellingPrice) FROM Products.ProductVariantTbl v
             WHERE v.ProductUID = p.ProductUID AND v.OrgUID = p.OrgUID AND v.IsDeleted = 0 AND v.IsActive = 1)`
        ),
        imagePath: knexRead.raw(
          `(SELECT ea.FilePath FROM Products.EntityAttachmentsTbl ea
             WHERE ea.EntityType = 'Product' AND ea.EntityUID = p.ProductUID AND ea.OrgUID = p.OrgUID
               AND ea.IsDeleted = 0 AND ea.IsActive = 1
             ORDER BY ea.SortOrder ASC LIMIT 1)`
        ),
      })
      .leftJoin({ c: "Products.CategoryTbl" }, function (this: Knex.JoinClause) {
        this.on("c.CategoryUID", "p.CategoryUID").andOn("c.OrgUID", "p.OrgUID");
      })
      .leftJoin({ s: "Products.ProductStockTbl" }, function (this: Knex.JoinClause) {
        this.on("s.ProductUID", "p.ProductUID").andOn("s.OrgUID", "p.OrgUID");
      });
  }

  private async queryProductList(orgUID: number, filters: ProductFilters): Promise<ProductListItem[]> {
    const inner = this.baseProductQuery()
      .where("p.OrgUID", orgUID)
      .andWhere("p.IsDeleted", 0)
      .andWhere("p.IsActive", 1)
      .andWhere("p.ProductType", "Product");

    if (filters.category) {
      inner.andWhere("c.Name", filters.category);
    }
    if (filters.search) {
      inner.andWhere("p.ItemName", "like", `%${filters.search}%`);
    }
    if (filters.brand) {
      inner.andWhereRaw(
        `EXISTS (SELECT 1 FROM Products.ProductVariantTbl v JOIN Products.BrandTbl b ON b.BrandUID = v.BrandUID AND b.OrgUID = v.OrgUID
           WHERE v.ProductUID = p.ProductUID AND v.OrgUID = p.OrgUID AND v.IsDeleted = 0 AND v.IsActive = 1 AND b.BrandName = ?)`,
        [filters.brand]
      );
    }

    const outer = knexRead
      .select("t.*")
      .select({ effectivePrice: knexRead.raw("COALESCE(t.variantMinPrice, t.basePrice)") })
      .from(inner.as("t"));

    if (filters.minPrice !== undefined) {
      outer.andWhereRaw("COALESCE(t.variantMinPrice, t.basePrice) >= ?", [filters.minPrice]);
    }
    if (filters.maxPrice !== undefined) {
      outer.andWhereRaw("COALESCE(t.variantMinPrice, t.basePrice) <= ?", [filters.maxPrice]);
    }

    const sortColumn = SORT_COLUMNS[filters.sort || "newest"] || SORT_COLUMNS.newest;
    outer.orderByRaw(sortColumn);

    const rows = await outer;
    return rows.map(mapRow);
  }

  async listProducts(orgUID: number, filters: ProductFilters): Promise<ProductFullDetail[]> {
    const items = await this.queryProductList(orgUID, filters);
    const details = await Promise.all(items.map((item) => this.getProductFullDetail(orgUID, item.productUID)));
    return details.filter((detail): detail is ProductFullDetail => detail !== null);
  }

  async listCategories(orgUID: number): Promise<{ categoryUID: number; name: string }[]> {
    return knexRead("Products.CategoryTbl")
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy("Name")
      .select({ categoryUID: "CategoryUID", name: "Name" });
  }

  async listBrands(orgUID: number): Promise<{ brandUID: number; name: string }[]> {
    return knexRead({ b: "Products.BrandTbl" })
      .join({ v: "Products.ProductVariantTbl" }, function (this: Knex.JoinClause) {
        this.on("v.BrandUID", "b.BrandUID").andOn("v.OrgUID", "b.OrgUID");
      })
      .where({ "b.OrgUID": orgUID, "b.IsDeleted": 0, "b.IsActive": 1, "v.IsDeleted": 0, "v.IsActive": 1 })
      .orderBy("b.BrandName")
      .distinct({ brandUID: "b.BrandUID", name: "b.BrandName" });
  }

  async getProductById(orgUID: number, productUID: number): Promise<ProductDetail | null> {
    const row = await this.baseProductQuery()
      .where("p.OrgUID", orgUID)
      .andWhere("p.ProductUID", productUID)
      .andWhere("p.IsDeleted", 0)
      .andWhere("p.IsActive", 1)
      .first();
    if (!row) return null;
    const base = mapRow(row);

    const variantRows: ProductVariant[] = await knexRead({ v: "Products.ProductVariantTbl" })
      .leftJoin({ b: "Products.BrandTbl" }, function (this: Knex.JoinClause) {
        this.on("b.BrandUID", "v.BrandUID").andOn("b.OrgUID", "v.OrgUID");
      })
      .leftJoin({ sz: "Products.SizeTbl" }, function (this: Knex.JoinClause) {
        this.on("sz.SizeUID", "v.SizeUID").andOn("sz.OrgUID", "v.OrgUID");
      })
      .where("v.ProductUID", productUID)
      .andWhere("v.OrgUID", orgUID)
      .andWhere("v.IsDeleted", 0)
      .andWhere("v.IsActive", 1)
      .select({
        variantUID: "v.VariantUID",
        brandUID: "v.BrandUID",
        brand: "b.BrandName",
        sizeUID: "v.SizeUID",
        size: "sz.Name",
        partNumber: "v.PartNumber",
        price: "v.SellingPrice",
      });

    const imageRows: { FilePath: string }[] = await knexRead("Products.EntityAttachmentsTbl")
      .where({ EntityType: "Product", EntityUID: productUID, OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy("SortOrder", "asc")
      .select("FilePath");

    return {
      ...base,
      variants: variantRows,
      images: imageRows.map((row) => toImageUrl(row.FilePath)).filter((url): url is string => url !== null),
    };
  }

  async getVariantById(orgUID: number, productUID: number, variantUID: number): Promise<ProductVariant | null> {
    const row: ProductVariant | undefined = await knexRead({ v: "Products.ProductVariantTbl" })
      .leftJoin({ b: "Products.BrandTbl" }, function (this: Knex.JoinClause) {
        this.on("b.BrandUID", "v.BrandUID").andOn("b.OrgUID", "v.OrgUID");
      })
      .leftJoin({ sz: "Products.SizeTbl" }, function (this: Knex.JoinClause) {
        this.on("sz.SizeUID", "v.SizeUID").andOn("sz.OrgUID", "v.OrgUID");
      })
      .where({
        "v.VariantUID": variantUID,
        "v.ProductUID": productUID,
        "v.OrgUID": orgUID,
        "v.IsDeleted": 0,
        "v.IsActive": 1,
      })
      .select({
        variantUID: "v.VariantUID",
        brandUID: "v.BrandUID",
        brand: "b.BrandName",
        sizeUID: "v.SizeUID",
        size: "sz.Name",
        partNumber: "v.PartNumber",
        price: "v.SellingPrice",
      })
      .first();
    return row ?? null;
  }

  async hasActiveVariants(orgUID: number, productUID: number): Promise<boolean> {
    const row = await knexRead("Products.ProductVariantTbl")
      .where({ ProductUID: productUID, OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .first(knexRead.raw("1 as one"));
    return row !== undefined;
  }

  async createProduct(orgUID: number, input: CreateProductInput): Promise<ProductDetail> {
    const prodToken = crypto.randomUUID();
    const [productUID] = await knexWrite("Products.ProductTbl").insert({
      OrgUID: orgUID,
      ProdToken: prodToken,
      ItemName: input.name,
      Description: input.description || "",
      UnitPrice: input.price,
      SellingPrice: input.price,
      MRP: input.mrp || 0,
      CategoryUID: input.categoryUID ?? null,
      TaxDetailsUID: 1,
      TaxPercentage: 0,
      CGST: 0,
      SGST: 0,
      IGST: 0,
    });

    await knexWrite("Products.ProductStockTbl").insert({ ProductUID: productUID, OrgUID: orgUID, AvailableQty: input.stock });

    const created = await this.getProductById(orgUID, productUID);
    if (!created) throw new Error("Failed to load created product");
    return created;
  }

  async updateProduct(orgUID: number, productUID: number, input: UpdateProductInput): Promise<ProductDetail | null> {
    const existing = await this.getProductById(orgUID, productUID);
    if (!existing) return null;

    const updateData: Record<string, unknown> = {};
    if (input.name !== undefined) updateData.ItemName = input.name;
    if (input.description !== undefined) updateData.Description = input.description;
    if (input.price !== undefined) {
      updateData.SellingPrice = input.price;
      updateData.UnitPrice = input.price;
    }
    if (input.mrp !== undefined) updateData.MRP = input.mrp;
    if (input.categoryUID !== undefined) updateData.CategoryUID = input.categoryUID;

    if (Object.keys(updateData).length > 0) {
      await knexWrite("Products.ProductTbl").where({ ProductUID: productUID, OrgUID: orgUID }).update(updateData);
    }

    if (input.stock !== undefined) {
      await knexWrite("Products.ProductStockTbl")
        .insert({ ProductUID: productUID, OrgUID: orgUID, AvailableQty: input.stock })
        .onConflict(["ProductUID", "OrgUID"])
        .merge({ AvailableQty: input.stock });
    }

    return this.getProductById(orgUID, productUID);
  }

  async deleteProduct(orgUID: number, productUID: number): Promise<boolean> {
    const affectedRows = await knexWrite("Products.ProductTbl")
      .where({ ProductUID: productUID, OrgUID: orgUID, IsDeleted: 0 })
      .update({ IsDeleted: 1 });
    return affectedRows > 0;
  }

  async decrementStock(orgUID: number, productUID: number, quantity: number): Promise<void> {
    await knexWrite("Products.ProductStockTbl")
      .where({ ProductUID: productUID, OrgUID: orgUID })
      .decrement("AvailableQty", quantity);
  }

  async getProductFullDetail(orgUID: number, productUID: number): Promise<ProductFullDetail | null> {
    const row = await knexRead<Omit<ProductFullDetail, "variants" | "brandStock" | "images">>({ p: "Products.ProductTbl" })
      .select({
        productUID: "p.ProductUID",
        orgUID: "p.OrgUID",
        prodToken: "p.ProdToken",
        name: "p.ItemName",
        productType: "p.ProductType",
        unitPrice: "p.UnitPrice",
        mrp: "p.MRP",
        sellingPrice: "p.SellingPrice",
        sellingProductTaxUID: "p.SellingProductTaxUID",
        sellingProductTaxName: "pt1.Name",
        taxDetailsUID: "p.TaxDetailsUID",
        taxName: "td.TaxName",
        taxDisplayName: "td.DisplayName",
        taxPercentage: "p.TaxPercentage",
        cgst: "p.CGST",
        sgst: "p.SGST",
        igst: "p.IGST",
        primaryUnitUID: "p.PrimaryUnitUID",
        primaryUnitName: "pu.Name",
        primaryUnitShortName: "pu.ShortName",
        categoryUID: "p.CategoryUID",
        category: "c.Name",
        storageUID: "p.StorageUID",
        storage: "st.Name",
        hsnSacCode: "p.HSNSACCode",
        purchasePrice: "p.PurchasePrice",
        purchasePriceProductTaxUID: "p.PurchasePriceProductTaxUID",
        purchasePriceProductTaxName: "pt2.Name",
        partNumber: "p.PartNumber",
        sku: "p.SKU",
        description: "p.Description",
        openingQuantity: "p.OpeningQuantity",
        openingPurchasePrice: "p.OpeningPurchasePrice",
        openingStockValue: "p.OpeningStockValue",
        discount: "p.Discount",
        discountTypeUID: "p.DiscountTypeUID",
        discountTypeName: "dt.DisplayName",
        discountTypeSymbol: "dt.Symbol",
        lowStockAlertAt: "p.LowStockAlertAt",
        notForSale: "p.NotForSale",
        isRentable: "p.IsRentable",
        isSizeApplicable: "p.IsSizeApplicable",
        isComboItem: "p.IsComboItem",
        isComposite: "p.IsComposite",
        isBrandApplicable: "p.IsBrandApplicable",
        isSerialTracked: "p.IsSerialTracked",
        isActive: "p.IsActive",
        isDeleted: "p.IsDeleted",
        createdBy: "p.CreatedBy",
        updatedBy: "p.UpdatedBy",
        createdOn: "p.CreatedOn",
        updatedOn: "p.UpdatedOn",
        stock: knexRead.raw("COALESCE(s.AvailableQty, 0)"),
      })
      .leftJoin({ c: "Products.CategoryTbl" }, function (this: Knex.JoinClause) {
        this.on("c.CategoryUID", "p.CategoryUID").andOn("c.OrgUID", "p.OrgUID");
      })
      .leftJoin({ st: "Products.StorageTbl" }, "st.StorageUID", "p.StorageUID")
      .leftJoin({ s: "Products.ProductStockTbl" }, function (this: Knex.JoinClause) {
        this.on("s.ProductUID", "p.ProductUID").andOn("s.OrgUID", "p.OrgUID");
      })
      .leftJoin({ td: "Global.TaxDetailsTbl" }, "td.TaxDetailsUID", "p.TaxDetailsUID")
      .leftJoin({ pu: "Global.PrimaryUnitTbl" }, "pu.PrimaryUnitUID", "p.PrimaryUnitUID")
      .leftJoin({ dt: "Global.DiscountTypeTbl" }, "dt.DiscountTypeUID", "p.DiscountTypeUID")
      .leftJoin({ pt1: "Global.ProductTaxTbl" }, "pt1.ProductTaxUID", "p.SellingProductTaxUID")
      .leftJoin({ pt2: "Global.ProductTaxTbl" }, "pt2.ProductTaxUID", "p.PurchasePriceProductTaxUID")
      .where("p.OrgUID", orgUID)
      .andWhere("p.ProductUID", productUID)
      .andWhere("p.IsDeleted", 0)
      .first();

    if (!row) return null;

    const variantRows = await knexRead<ProductFullVariant>({ v: "Products.ProductVariantTbl" })
      .select({
        variantUID: "v.VariantUID",
        brandUID: "v.BrandUID",
        brand: "b.BrandName",
        sizeUID: "v.SizeUID",
        size: "sz.Name",
        sizeCode: "sz.SizeCode",
        sizeDescription: "sz.Description",
        partNumber: "v.PartNumber",
        purchasePrice: "v.PurchasePrice",
        purchaseTaxUID: "v.PurchaseTaxUID",
        sellingPrice: "v.SellingPrice",
        sellingTaxUID: "v.SellingTaxUID",
        isActive: "v.IsActive",
        isDeleted: "v.IsDeleted",
        openingQty: knexRead.raw("COALESCE(vs.OpeningQty, 0)"),
        availableQty: knexRead.raw("COALESCE(vs.AvailableQty, 0)"),
        createdOn: "v.CreatedOn",
        updatedOn: "v.UpdatedOn",
      })
      .leftJoin({ b: "Products.BrandTbl" }, function (this: Knex.JoinClause) {
        this.on("b.BrandUID", "v.BrandUID").andOn("b.OrgUID", "v.OrgUID");
      })
      .leftJoin({ sz: "Products.SizeTbl" }, function (this: Knex.JoinClause) {
        this.on("sz.SizeUID", "v.SizeUID").andOn("sz.OrgUID", "v.OrgUID");
      })
      .leftJoin({ vs: "Products.ProductVariantStockTbl" }, function (this: Knex.JoinClause) {
        this.on("vs.VariantUID", "v.VariantUID").andOn("vs.OrgUID", "v.OrgUID");
      })
      .where("v.ProductUID", productUID)
      .andWhere("v.OrgUID", orgUID)
      .andWhere("v.IsDeleted", 0);

    const brandStockRows = await knexRead<ProductBrandStock>({ bs: "Products.ProductBrandStockTbl" })
      .select({
        brandUID: "bs.BrandUID",
        brand: "b.BrandName",
        openingQty: "bs.OpeningQty",
        availableQty: "bs.AvailableQty",
        updatedOn: "bs.UpdatedOn",
      })
      .leftJoin({ b: "Products.BrandTbl" }, function (this: Knex.JoinClause) {
        this.on("b.BrandUID", "bs.BrandUID").andOn("b.OrgUID", "bs.OrgUID");
      })
      .where("bs.ProductUID", productUID)
      .andWhere("bs.OrgUID", orgUID);

    const imageRows: {
      attachUID: number;
      fileName: string;
      filePath: string;
      fileSize: number;
      sortOrder: number;
      isActive: boolean;
      createdOn: Date;
      updatedOn: Date;
    }[] = await knexRead("Products.EntityAttachmentsTbl")
      .where({ EntityType: "Product", EntityUID: productUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("SortOrder", "asc")
      .select({
        attachUID: "AttachUID",
        fileName: "FileName",
        filePath: "FilePath",
        fileSize: "FileSize",
        sortOrder: "SortOrder",
        isActive: "IsActive",
        createdOn: "CreatedOn",
        updatedOn: "UpdatedOn",
      });

    return {
      ...row,
      variants: variantRows,
      brandStock: brandStockRows,
      images: imageRows.map((image) => ({
        ...image,
        imageUrl: toImageUrl(image.filePath),
      })),
    };
  }
}
