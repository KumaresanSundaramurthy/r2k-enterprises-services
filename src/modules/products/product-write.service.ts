import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettings, OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postIntList, postJsonArray, postString, postValue } from "../../core/utils/form-values";
import { CiFormValidator, FieldRules } from "../../core/validation/ci-form-validator";
import { phpRound, toInt } from "../../common/utils/php-compat";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { ProductListFilterDto } from "./dto/product-list.dto";
import { ComboFormDto, ComboIdDto, ProductBulkDeleteDto, ProductFormDto, ProductIdDto, ProductStatusDto, RecalcStockDto } from "./dto/product-write.dto";
import { ProductAttachmentService, UploadedFile } from "./product-attachment.service";
import { ProductCacheService } from "./product-cache.service";
import { ProductItemsService } from "./product-items.service";
import { ProductTextService } from "./product-text.service";
import { ProductsRepository, Row, VariantInput } from "./products.repository";

// CI3 Formvalidation_model::productValidateForm — rules only apply to fields that are submitted.
const PRODUCT_RULES: FieldRules = {
  ProductUID: { label: "Product UID", required: true, numeric: true },
  ItemName: { label: "Item Name", required: true, minLength: 3, maxLength: 100 },
  ProductType: { label: "Product Type", required: true, inList: ["Product", "Service"] },
  SellingPrice: { label: "Selling Price", required: true, numeric: true, greaterThan: 0 },
  SellingTaxOption: { label: "Selling Tax Option", required: true, numeric: true },
  TaxPercentage: { label: "Tax Percentage", required: true, numeric: true },
  PrimaryUnit: { label: "Primary Unit", required: true, numeric: true },
  Category: { label: "Category", required: true, numeric: true },
  HSNCode: { label: "HSN/ SAC Code", maxLength: 100 },
  PurchasePrice: { label: "Purchase Price", numeric: true, greaterThan: 0 },
  PurchaseTaxOption: { label: "Purchase Tax Option", numeric: true },
  PartNumber: { label: "Part Number", maxLength: 25 },
  OpeningQuantity: { label: "Opening Quantity", numeric: true },
  OpeningPurchasePrice: { label: "Opening Purchase Price", numeric: true },
  OpeningStockValue: { label: "Opening Stock Value", numeric: true },
  Discount: { label: "Discount", numeric: true },
  DiscountOption: { label: "Discount Option", required: true, numeric: true },
  LowStockAlert: { label: "Low Stock Alert at", numeric: true },
  BrandUID: { label: "Brand UID", numeric: true },
  Standard: { label: "Standard", maxLength: 100 },
  IsSizeApplicable: { label: "Is Size Applicable" },
};

const productValidator = (org: OrgSettings) =>
  new CiFormValidator(
    org.EnableStorage === 1
      ? { ...PRODUCT_RULES, StorageUID: { label: "Storage UID", required: org.MandatoryStorage === 1, numeric: true } }
      : PRODUCT_RULES
  );

// PHP (float) / (int) of a posted value with a default for missing or empty
const num = (form: object, key: string, fallback = 0) => Number(postValue(form, key, fallback)) || 0;
const flag = (form: object, key: string) => (String(postValue(form, key) ?? "") === "1" ? 1 : 0);

// The filter posted with a list refresh (JSON string or object), reduced to the known keys
function toFilter(value: unknown): ProductListFilterDto {
  if (typeof value === "string") {
    try {
      return (JSON.parse(value) as ProductListFilterDto) ?? {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as ProductListFilterDto) : {};
}

/** Item and combo writes and stock recalculation (CI3 Products controller write actions). */
@Injectable()
export class ProductWriteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly products: ProductsRepository,
    private readonly itemsRead: ProductItemsService,
    private readonly orgSettings: OrgSettingsService,
    private readonly text: ProductTextService,
    private readonly cache: ProductCacheService,
    private readonly attachments: ProductAttachmentService,
    private readonly audit: AuditLogService
  ) {}

  /**
   * addProductData — in one transaction: the product, its rental config and its opening stock (per variant for
   * size / brand products). Afterwards: Tamil text (background), cache, images and audit.
   */
  async create(form: ProductFormDto, ctx: WriteContext, files: UploadedFile[] = []) {
    const org = await this.orgSettings.get(ctx.orgUID);
    this.validate(form, org);
    const tax = await this.products.findTaxDetail(postInt(form, "TaxPercentage"));
    const { row, typed, unitPrice } = await this.buildRow(form, ctx, org, tax, true);
    const variants = this.variantsOf(form);
    const isVariant = row.IsBrandApplicable === 1 || row.IsSizeApplicable === 1;

    const productUID = await this.db.transaction(async (trx) => {
      const uid = await this.products.insertProduct(trx, row);
      await this.saveRentalConfig(trx, ctx, uid, form);
      if (isVariant) {
        let total = 0;
        for (const variant of variants) {
          const variantUID = await this.products.upsertVariant(trx, ctx.orgUID, uid, variant, ctx.userUID);
          if (variantUID > 0) {
            await this.products.upsertVariantStock(trx, ctx.orgUID, variantUID, variant.openingQty);
            total += variant.openingQty;
          }
        }
        await this.products.initStock(trx, ctx.orgUID, uid, total);
        await this.products.syncVariantStockTotal(trx, ctx.orgUID, uid);
      } else {
        await this.products.initStock(trx, ctx.orgUID, uid, Number(row.OpeningQuantity ?? 0));
      }
      return uid;
    });

    this.scheduleTamil(productUID, typed, ctx.userUID);
    await this.cache.refreshProduct(ctx.orgUID, productUID);
    await this.attachments.apply(ctx, "Product", productUID, postString(form, "ProdAttachDeleteUIDs"), files);
    await this.audit.log(ctx, {
      action: "CREATE_PRODUCT",
      entityType: "Product",
      entityUID: productUID,
      entityRef: String(row.ItemName ?? ""),
      summary: `Created product ${row.ItemName ?? ""}`,
      module: "Products",
      category: "MASTER",
      newValues: row,
    });

    // The new item as the transaction forms need it, built from the form (no extra query)
    const taxPercent = Number(tax?.Percentage ?? 0);
    return {
      Message: "Created Successfully",
      ProductUID: productUID,
      Product: {
        id: productUID,
        text: row.ItemName,
        itemName: row.ItemName,
        productType: postString(form, "ProductType", "Product"),
        unitPrice,
        taxAmount: phpRound((unitPrice * taxPercent) / 100, AMOUNT_DECIMALS),
        sellingPrice: num(form, "SellingPrice"),
        purchasePrice: num(form, "PurchasePrice"),
        availableQuantity: num(form, "OpeningQuantity"),
        hsnCode: postString(form, "HSNCode"),
        partNumber: postString(form, "PartNumber"),
        taxPercent,
        taxDetailsUID: postInt(form, "TaxPercentage"),
        cgstPercent: Number(tax?.CGST ?? 0),
        sgstPercent: Number(tax?.SGST ?? 0),
        igstPercent: Number(tax?.IGST ?? 0),
        discount: num(form, "Discount"),
        discountTypeUID: postInt(form, "DiscountOption"),
        primaryUnit: "",
        isComboItem: 0,
        comboItemCount: 0,
      },
    };
  }

  /**
   * updateProductData — in one transaction: the product, its stock (variants, refused when a variant already used
   * in transactions is removed; or the change in opening quantity) and its rental config. Afterwards as create.
   */
  async update(form: ProductFormDto, ctx: WriteContext, files: UploadedFile[] = []) {
    if (!Object.prototype.hasOwnProperty.call(form, "ProductUID")) form.ProductUID = "";
    const org = await this.orgSettings.get(ctx.orgUID);
    this.validate(form, org);
    const tax = await this.products.findTaxDetail(postInt(form, "TaxPercentage"));
    const productUID = postInt(form, "ProductUID");

    if (flag(form, "NotForSale") === 1 && (await this.products.isLinkedToCombo(productUID))) {
      throw new CiValidationError("This item is already linked with a combo. You cannot mark it as Not for Sale.");
    }
    const current = await this.products.findTypeAndOpeningQty(ctx.orgUID, productUID);
    if (!current) throw new CiValidationError("Product not found");
    const { row, typed } = await this.buildRow(form, ctx, org, tax, false);
    const isVariant = row.IsBrandApplicable === 1 || row.IsSizeApplicable === 1;
    const variants = this.variantsOf(form);

    if ((current.ProductType ?? "Product") === "Product" && isVariant) {
      const used = await this.products.findUsedVariants(ctx.orgUID, productUID);
      const submitted = new Set(variants.map((variant) => `${variant.sizeUID}-${variant.brandUID}`));
      if (used.some((variant) => !submitted.has(`${toInt(variant.SizeUID)}-${toInt(variant.BrandUID)}`))) {
        throw new CiValidationError(
          "One or more variants are used in transactions and cannot be removed. Please update or cancel those transactions first."
        );
      }
    }

    await this.db.transaction(async (trx) => {
      await this.products.updateProduct(ctx.orgUID, [productUID], row, trx);
      if ((current.ProductType ?? "Product") === "Product") {
        if (isVariant) {
          for (const variant of variants) {
            const variantUID = await this.products.upsertVariant(trx, ctx.orgUID, productUID, variant, ctx.userUID);
            if (variantUID > 0) await this.products.upsertVariantStock(trx, ctx.orgUID, variantUID, variant.openingQty);
          }
          await this.products.syncVariantStockTotal(trx, ctx.orgUID, productUID);
        } else {
          const delta = phpRound(Number(row.OpeningQuantity ?? 0) - Number(current.OpeningQuantity ?? 0), 4);
          await this.products.applyStockDelta(trx, ctx.orgUID, productUID, delta);
        }
      }
      await this.saveRentalConfig(trx, ctx, productUID, form);
    });

    this.scheduleTamil(productUID, typed, ctx.userUID);
    await this.cache.refreshProduct(ctx.orgUID, productUID);
    await this.attachments.apply(ctx, "Product", productUID, postString(form, "ProdAttachDeleteUIDs"), files);
    await this.audit.log(ctx, {
      action: "UPDATE_PRODUCT",
      entityType: "Product",
      entityUID: productUID,
      entityRef: String(row.ItemName ?? ""),
      summary: `Updated product ${row.ItemName ?? ""}`,
      module: "Products",
      category: "MASTER",
      oldValues: current,
      newValues: row,
    });
    return { Message: "Updated Successfully", ProductUID: productUID };
  }

  // deleteProductDetails — refused while the item is in a combo or used in transactions
  async delete(dto: ProductIdDto, ctx: WriteContext) {
    const productUID = postInt(dto, "ProductUID");
    if (productUID <= 0) throw new CiValidationError("Invalid Product Information");
    await this.requireDeletable(productUID, {
      combo: "This item is already linked with a combo. You cannot delete it.",
      transactions: "This item has been used in transactions. You cannot delete it.",
      comboTransactions: "This item has been used in a combo that has transactions. You cannot delete it.",
    });
    const before = await this.products.findDetail(ctx.orgUID, productUID, "en");
    await this.products.updateProduct(ctx.orgUID, [productUID], { IsDeleted: 1, UpdatedBy: ctx.userUID });
    await this.cache.removeProducts(ctx.orgUID, [productUID]);
    await this.audit.log(ctx, {
      action: "DELETE_PRODUCT",
      entityType: "Product",
      entityUID: productUID,
      entityRef: before?.ItemName ?? "",
      summary: `Deleted product #${productUID}`,
      module: "Products",
      category: "MASTER",
      oldValues: before ?? {},
    });
    return { Message: "Deleted Successfully" };
  }

  // deleteBulkProduct — the selected items, or every item matching the list filter (SelectAll = 1)
  async deleteBulk(dto: ProductBulkDeleteDto, ctx: WriteContext) {
    let productUIDs: number[];
    if (postInt(dto, "SelectAll") === 1) {
      productUIDs = await this.products.findUIDsByFilter(ctx.orgUID, toFilter(dto.Filter));
    } else {
      if (postValue(dto, "ProductUIDs") === null) throw new CiValidationError("No products selected for deletion");
      productUIDs = postIntList(dto, "ProductUIDs");
    }
    if (productUIDs.length === 0) throw new CiValidationError("Invalid product IDs provided");

    for (const productUID of productUIDs) {
      await this.requireDeletable(productUID, {
        combo: "One or more selected items are linked to a combo. Remove them from the combo before deleting.",
        transactions: "One or more selected items have been used in transactions and cannot be deleted.",
        comboTransactions: "One or more selected items have been used in a combo that has transactions and cannot be deleted.",
      });
    }
    await this.products.updateProduct(ctx.orgUID, productUIDs, { IsDeleted: 1, UpdatedBy: ctx.userUID });
    // CI3 dropped only the single-entry keys; the entries are also taken out of the products map here
    await this.cache.removeProducts(ctx.orgUID, productUIDs, ["products:all"]);
    await this.audit.log(ctx, {
      action: "BULK_DELETE_PRODUCTS",
      entityType: "Product",
      entityUID: 0,
      entityRef: productUIDs.join(","),
      details: { count: productUIDs.length },
      summary: `Bulk deleted ${productUIDs.length} product(s)`,
      module: "Products",
      category: "MASTER",
      oldValues: { deletedUIDs: productUIDs },
    });
    return { Message: `${productUIDs.length} product(s) deleted successfully` };
  }

  // toggleProductStatus — an inactive product is also taken out of the transaction-form cache
  async setStatus(dto: ProductStatusDto, ctx: WriteContext) {
    const productUID = postInt(dto, "ProductUID");
    const isActive = postInt(dto, "IsActive");
    if (!productUID) throw new CiValidationError("Product ID is missing");
    if (isActive !== 0 && isActive !== 1) throw new CiValidationError("Invalid status value");
    const updated = await this.products.updateProduct(ctx.orgUID, [productUID], { IsActive: isActive, UpdatedBy: ctx.userUID });
    if (updated === 0) throw new CiValidationError("Product not found");
    if (isActive === 1) await this.cache.refreshProduct(ctx.orgUID, productUID);
    else await this.cache.removeProducts(ctx.orgUID, [productUID]);
    await this.audit.log(ctx, {
      action: "TOGGLE_PRODUCT_STATUS",
      entityType: "Product",
      entityUID: productUID,
      details: { isActive },
      summary: `${isActive ? "Activated" : "Deactivated"} product #${productUID}`,
      module: "Products",
      category: "MASTER",
      oldValues: { IsActive: 1 - isActive },
      newValues: { IsActive: isActive },
    });
    return { Message: "Status updated successfully" };
  }

  // addComboItem / editComboItem — the combo (IsComposite 1) and its components (BOM) in one transaction
  async saveCombo(form: ComboFormDto, ctx: WriteContext, isEdit: boolean) {
    const comboUID = postInt(form, "ComboUID");
    if (isEdit && !comboUID) throw new CiValidationError("Invalid combo item.");
    const names = await this.text.normalize(postString(form, "ComboName"), null);
    let price = num(form, "ComboSellingPrice");
    const purchasePrice = Number(postValue(form, "ComboPurchasePrice", -1));
    if (!names.name) throw new CiValidationError("Combo name is required.");
    if (!isEdit && price < 0) throw new CiValidationError("Selling price must be 0 or greater.");
    if (!(purchasePrice >= 0)) throw new CiValidationError("Purchase price is required and must be 0 or greater.");
    const components = postJsonArray<Record<string, unknown>>(form, "ComboComponentsData");
    if (components.length < 2) throw new CiValidationError("A combo item must have at least 2 component items.");

    const taxUID = postInt(form, "ComboTaxPercentage");
    const tax = taxUID > 0 ? await this.products.findTaxDetail(taxUID) : null;
    const taxPercent = Number(tax?.Percentage ?? 0);
    const sellingTaxUID = postInt(form, "ComboSellingTaxOption");
    let unitPrice = price;
    if (taxPercent > 0 && sellingTaxUID === 1) {
      unitPrice = price / (1 + taxPercent / 100); // entered price includes tax
    } else if (taxPercent > 0) {
      price = phpRound(price * (1 + taxPercent / 100), 4); // entered price excludes tax
    }

    const row: Record<string, unknown> = {
      ItemName: names.name,
      UnitPrice: phpRound(unitPrice, 5),
      SellingPrice: price,
      SellingProductTaxUID: sellingTaxUID || null,
      PurchasePrice: purchasePrice,
      PurchasePriceProductTaxUID: postInt(form, "ComboPurchaseTaxOption") || null,
      MRP: num(form, "ComboMRP"),
      TaxDetailsUID: taxUID || null,
      TaxPercentage: tax?.Percentage ?? null,
      CGST: tax?.CGST ?? null,
      SGST: tax?.SGST ?? null,
      IGST: tax?.IGST ?? null,
      Description: postString(form, "ComboDescription"),
      PrimaryUnitUID: postInt(form, "ComboPrimaryUnit") || null,
      UpdatedBy: ctx.userUID,
    };
    const before = isEdit ? await this.products.findDetail(ctx.orgUID, comboUID, "en", true) : null;

    const uid = await this.db.transaction(async (trx) => {
      const id = isEdit
        ? (await this.products.updateProduct(ctx.orgUID, [comboUID], row, trx), comboUID)
        : await this.products.insertProduct(trx, {
            ...row,
            OrgUID: ctx.orgUID,
            ProdToken: randomUUID(),
            ProductType: "Product",
            IsComposite: 1,
            IsComboItem: 0,
            CreatedBy: ctx.userUID,
          });
      const bom = components
        .map((component) => ({ childUID: toInt(component.ItemUID), qty: component.Qty === undefined ? 1 : Number(component.Qty) || 0 }))
        .filter((component) => component.childUID > 0 && component.qty > 0 && component.childUID !== id);
      await this.products.replaceBOM(trx, ctx.orgUID, id, bom, ctx.userUID);
      return id;
    });

    await this.cache.refreshProduct(ctx.orgUID, uid);
    this.scheduleTamil(uid, names.typed, ctx.userUID);
    await this.audit.log(ctx, {
      action: isEdit ? "UPDATE_COMBO_ITEM" : "CREATE_COMBO_ITEM",
      entityType: "ComboItem",
      entityUID: uid,
      entityRef: String(names.name),
      summary: `${isEdit ? "Updated" : "Created"} combo item ${names.name}`,
      module: "Products",
      category: "MASTER",
      oldValues: before ?? {},
      newValues: row,
    });

    const result: Record<string, unknown> = { Message: isEdit ? "Combo item updated successfully" : "Combo item created successfully" };
    if (String(postValue(form, "getTableDetails") ?? "") === "1") {
      const page = await this.itemsRead.getGroupsPage(ctx.orgUID, postInt(form, "PageNo") || 1, postInt(form, "RowLimit") || undefined, toFilter(form.Filter));
      Object.assign(result, { Data: page.Data, TotalCount: page.TotalCount, PageNo: page.PageNo, RowLimit: page.RowLimit, Stats: await this.itemsRead.getStats(ctx.orgUID) });
    }
    return result;
  }

  // deleteComboItem — soft-deletes the combo and its components
  async deleteCombo(dto: ComboIdDto, ctx: WriteContext) {
    const comboUID = postInt(dto, "ComboUID");
    if (!comboUID) throw new CiValidationError("Invalid combo item.");
    const before = await this.products.findDetail(ctx.orgUID, comboUID, "en", true);
    await this.db.transaction(async (trx) => {
      await trx("Products.ProductTbl").where({ ProductUID: comboUID, OrgUID: ctx.orgUID, IsComposite: 1 }).update({ IsDeleted: 1, UpdatedBy: ctx.userUID });
      await this.products.softDeleteBOM(trx, comboUID, ctx.userUID);
    });
    await this.cache.removeProducts(ctx.orgUID, [comboUID]);
    await this.audit.log(ctx, {
      action: "DELETE_COMBO_ITEM",
      entityType: "ComboItem",
      entityUID: comboUID,
      entityRef: before?.ItemName ?? "",
      summary: `Deleted combo item #${comboUID}`,
      module: "Products",
      category: "MASTER",
      oldValues: before ?? {},
    });
    return { Message: "Combo item deleted successfully" };
  }

  // recalcStock — available quantity = opening + ledger IN − OUT, for one product or every product (then the cache)
  async recalcStock(dto: RecalcStockDto, ctx: WriteContext) {
    const productUID = postInt(dto, "ProductUID");
    const rows = await this.products.stockData(ctx.orgUID, productUID);
    if (productUID > 0) {
      const [stock] = rows;
      if (!stock) throw new CiValidationError("Product not found.");
      const quantity = phpRound(stock.OpeningQty + stock.SumIn - stock.SumOut, AMOUNT_DECIMALS);
      await this.products.setAvailableQty(ctx.orgUID, productUID, quantity);
      await this.cache.refreshProduct(ctx.orgUID, productUID);
      return { Message: "Stock recalculated successfully.", RecalcQty: quantity, OpeningQty: stock.OpeningQty, SumIn: stock.SumIn, SumOut: stock.SumOut };
    }
    if (rows.length === 0) throw new CiValidationError("No products found for this organisation.");
    for (const stock of rows) {
      await this.products.setAvailableQty(ctx.orgUID, stock.ProductUID, phpRound(stock.OpeningQty + stock.SumIn - stock.SumOut, AMOUNT_DECIMALS));
    }
    await this.cache.syncProducts(ctx.orgUID);
    return { Message: `${rows.length} product(s) stock recalculated and cache refreshed.`, Count: rows.length };
  }

  // ProductTbl row from the form (CI3 buildProductFormData); Tamil name / description stored in English
  private async buildRow(form: ProductFormDto, ctx: WriteContext, org: OrgSettings, tax: Row | null, isCreate: boolean) {
    const names = await this.text.normalize(postString(form, "ItemName"), postString(form, "Description"));
    const sellingPrice = num(form, "SellingPrice");
    const taxPercent = Number(tax?.Percentage ?? 0);
    const unitPrice = postInt(form, "SellingTaxOption") === 1 && taxPercent > 0 ? sellingPrice / (1 + taxPercent / 100) : sellingPrice;
    const productType = postString(form, "ProductType", "Product");
    const isPhysical = (form.ProductType ?? "Product") === "Product";

    const row: Record<string, unknown> = {
      OrgUID: ctx.orgUID,
      ItemName: names.name,
      ProductType: productType === "Product" || productType === "Service" ? productType : "Product",
      MRP: num(form, "MRP"),
      UnitPrice: phpRound(unitPrice, 5),
      SellingPrice: sellingPrice,
      SellingProductTaxUID: postInt(form, "SellingTaxOption"),
      TaxDetailsUID: postInt(form, "TaxPercentage"),
      TaxPercentage: tax?.Percentage ?? null,
      CGST: tax?.CGST ?? null,
      SGST: tax?.SGST ?? null,
      IGST: tax?.IGST ?? null,
      PrimaryUnitUID: postInt(form, "PrimaryUnit"),
      CategoryUID: postInt(form, "Category"),
      HSNSACCode: postString(form, "HSNCode"),
      PurchasePrice: num(form, "PurchasePrice"),
      PurchasePriceProductTaxUID: postInt(form, "PurchaseTaxOption"),
      PartNumber: postString(form, "PartNumber"),
      SKU: null,
      Description: names.description,
      OpeningQuantity: isPhysical ? num(form, "OpeningQuantity") : 0,
      OpeningPurchasePrice: isPhysical ? num(form, "OpeningPurchasePrice") : 0,
      OpeningStockValue: isPhysical ? num(form, "OpeningStockValue") : 0,
      Discount: num(form, "Discount"),
      DiscountTypeUID: postInt(form, "DiscountOption"),
      LowStockAlertAt: postInt(form, "LowStockAlert"),
      NotForSale: flag(form, "NotForSale") === 1 ? "Yes" : "No",
      IsRentable: flag(form, "IsRentable"),
      IsSizeApplicable: flag(form, "IsSizeApplicable"),
      IsComboItem: 0,
      IsComposite: 0,
      IsBrandApplicable: flag(form, "IsBrandApplicable"),
      IsSerialTracked: flag(form, "IsSerialTracked"),
      UpdatedBy: ctx.userUID,
    };
    if (org.EnableStorage === 1) row.StorageUID = postValue(form, "StorageUID");
    if (isCreate) {
      row.ProdToken = randomUUID();
      row.CreatedBy = ctx.userUID;
    }
    return { row, typed: names.typed, unitPrice };
  }

  // VariantData JSON → variant rows
  private variantsOf(form: ProductFormDto): (VariantInput & { openingQty: number })[] {
    return postJsonArray<Record<string, unknown>>(form, "VariantData").map((variant) => ({
      brandUID: toInt(variant.BrandUID),
      sizeUID: toInt(variant.SizeUID),
      partNumber: String(variant.PartNumber ?? "").trim(),
      purchasePrice: Number(variant.PurchasePrice ?? 0) || 0,
      purchaseTaxUID: toInt(variant.PurchaseTaxUID),
      sellingPrice: Number(variant.SellingPrice ?? 0) || 0,
      sellingTaxUID: toInt(variant.SellingTaxUID),
      openingQty: Number(variant.OpeningQty ?? 0) || 0,
    }));
  }

  // _saveRentalConfig — only for rentable products
  private async saveRentalConfig(trx: Parameters<ProductsRepository["saveRentalConfig"]>[0], ctx: WriteContext, productUID: number, form: ProductFormDto) {
    if (flag(form, "IsRentable") !== 1) return;
    await this.products.saveRentalConfig(
      trx,
      ctx.orgUID,
      productUID,
      {
        SecurityDeposit: num(form, "rc_SecurityDeposit"),
        HourlyRate: num(form, "rc_HourlyRate"),
        HalfDayRate: num(form, "rc_HalfDayRate"),
        FullDayRate: num(form, "rc_FullDayRate"),
        FixedPackageRate: num(form, "rc_FixedPackageRate"),
        ExtraHourRate: num(form, "rc_ExtraHourRate"),
        LateReturnChargePerHour: num(form, "rc_LateReturnCharge"),
        DamagePenaltyRate: num(form, "rc_DamagePenaltyRate"),
        MinRentalHours: Math.max(1, postInt(form, "rc_MinRentalHours", 1)),
        UpdatedBy: ctx.userUID,
      },
      ctx.userUID
    );
  }

  private async requireDeletable(productUID: number, messages: { combo: string; transactions: string; comboTransactions: string }) {
    if (await this.products.isLinkedToCombo(productUID)) throw new CiValidationError(messages.combo);
    if (await this.products.hasTransactions(productUID)) throw new CiValidationError(messages.transactions);
    if (await this.products.usedInComboWithTransactions(productUID)) throw new CiValidationError(messages.comboTransactions);
  }

  private scheduleTamil(productUID: number, typed: Parameters<ProductTextService["scheduleTamil"]>[1], userUID: number) {
    this.text.scheduleTamil(`product ${productUID}`, typed, (name, description) =>
      this.products.saveLangRow(productUID, "ta", { ItemName: name, Description: description }, userUID)
    );
  }

  // CI3 answers a product form error with every message in Message and a fixed Errors text
  private validate(form: ProductFormDto, org: OrgSettings) {
    const errors = productValidator(org).validate(form as unknown as Record<string, unknown>);
    const messages = Object.values(errors);
    if (messages.length > 0) throw new CiValidationError(messages.join("\n"), { Errors: "Please correct the highlighted errors." });
  }
}
