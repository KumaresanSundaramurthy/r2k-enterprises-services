import { Injectable, Logger } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { toInt } from "../../common/utils/php-compat";
import { CacheHelperService } from "../../libraries/cache-helper/cache-helper.service";
import { PriceListCacheEntry, PriceListsRepository } from "./price-lists.repository";
import { ProductMastersRepository } from "./product-masters.repository";
import { ProductsRepository, Row } from "./products.repository";

type Entry = Record<string, unknown>;

// Single-entry keys CI3 Upstashservice also keeps (dropped whenever the entry changes)
const productKey = (uid: number) => `product:${uid}`;
const categoryKey = (uid: number) => `category:${uid}`;
const brandKey = (uid: number) => `brand:${uid}`;

// NotForSale is stored as 'Yes' / 'No'; CI3 compared (int)'Yes' with 1, so not-for-sale items were never left out
const isNotForSale = (value: unknown) => value === "Yes" || value === 1 || value === "1";

/**
 * Upstash caches the CI3 transaction forms read (CI3 Cachehelper product / category / brand / size methods,
 * the sync* actions and the price-list cache). Single refreshes never fail a save; full syncs report errors.
 */
@Injectable()
export class ProductCacheService {
  private readonly logger = new Logger(ProductCacheService.name);

  constructor(
    private readonly products: ProductsRepository,
    private readonly masters: ProductMastersRepository,
    private readonly priceLists: PriceListsRepository,
    private readonly cacheHelper: CacheHelperService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // ── Products ({org}-products) ─────────────────────────────────────────────

  // upsertProduct / upsertComboProduct — a not-for-sale product is removed instead
  async refreshProduct(orgUID: number, productUID: number): Promise<void> {
    await this.safely(`product ${productUID}`, async () => {
      const [row] = await this.products.findForCache(orgUID, productUID);
      if (!row) return;
      const token = await this.orgToken(orgUID);
      if (isNotForSale(row.NotForSale)) {
        await this.cacheHelper.removeOrgHashEntry("products", token, productUID, [productKey(productUID)]);
        return;
      }
      const [variants, bom] = await Promise.all([
        this.products.findVariantLabels(orgUID, productUID),
        toInt(row.IsComposite) ? this.products.findBOM(productUID, "en") : Promise.resolve([] as Row[]),
      ]);
      const items = bom.map((component) => ({ uid: toInt(component.ChildProductUID), qty: Number(component.Quantity) }));
      await this.cacheHelper.writeOrgHashEntry("products", token, productUID, this.productEntry(row, variants, items), [productKey(productUID)]);
    });
  }

  async removeProducts(orgUID: number, productUIDs: number[], alsoDelete: string[] = []): Promise<void> {
    await this.safely(`products ${productUIDs.join(",")}`, async () => {
      const token = await this.orgToken(orgUID);
      for (const uid of productUIDs) await this.cacheHelper.removeOrgHashEntry("products", token, uid, [productKey(uid)]);
      if (alsoDelete.length > 0) await this.cacheHelper.deleteKeys(...alsoDelete);
    });
  }

  // syncProductsCache — every active, for-sale product (combos with their components)
  async syncProducts(orgUID: number): Promise<number> {
    const [rows, boms, variants] = await Promise.all([
      this.products.findForCache(orgUID),
      this.products.allBOMsForSync(orgUID),
      this.products.findVariantLabels(orgUID),
    ]);
    const entries = new Map<number, Entry>();
    for (const row of rows) {
      if (isNotForSale(row.NotForSale)) continue;
      const uid = toInt(row.ProductUID);
      const items = boms
        .filter((component) => toInt(component.ParentProductUID) === uid)
        .map((component) => ({ uid: toInt(component.ChildProductUID), qty: Number(component.Quantity) }));
      entries.set(uid, this.productEntry(row, variants.filter((variant) => variant.ProductUID === uid), items));
    }
    await this.cacheHelper.replaceOrgHash("products", await this.orgToken(orgUID), entries);
    return rows.length;
  }

  // ── Categories ({org}-categories) ─────────────────────────────────────────

  // upsertCategory / syncCategoriesCache — the whole map is rebuilt from the active categories
  async syncCategories(orgUID: number, changedUID = 0): Promise<number> {
    const rows = await this.masters.findCategories(orgUID, "en");
    const entries = new Map<number, Entry>(
      rows.map((row) => [toInt(row.CategoryUID), { CategoryUID: toInt(row.CategoryUID), Name: row.Name ?? "", Description: row.Description ?? "" }])
    );
    await this.cacheHelper.replaceOrgHash("categories", await this.orgToken(orgUID), entries);
    if (changedUID > 0) await this.cacheHelper.deleteKeys(categoryKey(changedUID));
    return rows.length;
  }

  async refreshCategories(orgUID: number, changedUID: number): Promise<void> {
    await this.safely(`category ${changedUID}`, async () => {
      await this.syncCategories(orgUID, changedUID);
    });
  }

  async removeCategories(orgUID: number, categoryUIDs: number[]): Promise<void> {
    await this.safely(`categories ${categoryUIDs.join(",")}`, async () => {
      const token = await this.orgToken(orgUID);
      for (const uid of categoryUIDs) await this.cacheHelper.removeOrgHashEntry("categories", token, uid, [categoryKey(uid), "categories:all"]);
    });
  }

  // ── Brands ({org}-brands) ─────────────────────────────────────────────────

  async refreshBrand(orgUID: number, brandUID: number): Promise<void> {
    await this.safely(`brand ${brandUID}`, async () => {
      const brand = (await this.masters.findBrands(orgUID)).find((row) => toInt(row.BrandUID) === brandUID);
      if (!brand) return;
      const entry = await this.brandEntry(orgUID, brand);
      await this.cacheHelper.writeOrgHashEntry("brands", await this.orgToken(orgUID), brandUID, entry, [brandKey(brandUID)]);
    });
  }

  async removeBrands(orgUID: number, brandUIDs: number[]): Promise<void> {
    await this.safely(`brands ${brandUIDs.join(",")}`, async () => {
      const token = await this.orgToken(orgUID);
      for (const uid of brandUIDs) await this.cacheHelper.removeOrgHashEntry("brands", token, uid, [brandKey(uid), "brands:all"]);
    });
  }

  // syncBrandsCache
  async syncBrands(orgUID: number): Promise<number> {
    const rows = await this.masters.findBrands(orgUID);
    const entries = new Map<number, Entry>();
    for (const row of rows) entries.set(toInt(row.BrandUID), await this.brandEntry(orgUID, row));
    await this.cacheHelper.replaceOrgHash("brands", await this.orgToken(orgUID), entries);
    return rows.length;
  }

  // ── Sizes ({org}-sizes) ───────────────────────────────────────────────────

  // touchSize — an inactive size is not cached
  async refreshSize(orgUID: number, sizeUID: number): Promise<void> {
    await this.safely(`size ${sizeUID}`, async () => {
      const size = (await this.masters.findSizes(orgUID, true)).find((row) => toInt(row.SizeUID) === sizeUID);
      if (size) await this.cacheHelper.writeOrgHashEntry("sizes", await this.orgToken(orgUID), sizeUID, this.sizeEntry(size));
    });
  }

  async removeSizes(orgUID: number, sizeUIDs: number[]): Promise<void> {
    await this.safely(`sizes ${sizeUIDs.join(",")}`, async () => {
      const token = await this.orgToken(orgUID);
      for (const uid of sizeUIDs) await this.cacheHelper.removeOrgHashEntry("sizes", token, uid);
    });
  }

  // syncSizesCache
  async syncSizes(orgUID: number): Promise<number> {
    const rows = await this.masters.findSizes(orgUID, true);
    const entries = new Map<number, Entry>(rows.map((row) => [toInt(row.SizeUID), this.sizeEntry(row)]));
    await this.cacheHelper.replaceOrgHash("sizes", await this.orgToken(orgUID), entries);
    return rows.length;
  }

  // ── Price lists ({org}-price-lists, one JSON array, highest priority first) ──

  // _upsertOnePriceListCache — an inactive or deleted list is just removed
  async refreshPriceList(orgUID: number, priceListUID: number): Promise<void> {
    await this.safely(`price list ${priceListUID}`, async () => {
      const token = await this.orgToken(orgUID);
      const [entry] = await this.priceLists.findForCache(orgUID, priceListUID);
      const lists = (await this.currentPriceLists(token)).filter((list) => toInt(list.PriceListUID) !== priceListUID);
      if (entry) {
        lists.push(entry);
        lists.sort((a, b) => toInt(b.Priority) - toInt(a.Priority));
      }
      await this.cacheHelper.writeOrgValue("price-lists", token, lists);
    });
  }

  // _removeOnePriceListCache
  async removePriceList(orgUID: number, priceListUID: number): Promise<void> {
    await this.safely(`price list ${priceListUID}`, async () => {
      const token = await this.orgToken(orgUID);
      const lists = (await this.currentPriceLists(token)).filter((list) => toInt(list.PriceListUID) !== priceListUID);
      await this.cacheHelper.writeOrgValue("price-lists", token, lists);
    });
  }

  // syncPriceListCache
  async syncPriceLists(orgUID: number): Promise<PriceListCacheEntry[]> {
    const lists = await this.priceLists.findForCache(orgUID);
    await this.cacheHelper.writeOrgValue("price-lists", await this.orgToken(orgUID), lists);
    return lists;
  }

  // ── Entry shapes (the same keys CI3 writes) ───────────────────────────────

  private productEntry(row: Row, variants: Entry[], items: { uid: number; qty: number }[]): Entry {
    const entry: Entry = {
      ProductUID: toInt(row.ProductUID),
      ItemName: row.ItemName ?? "",
      ProductType: row.ProductType ?? "",
      CategoryUID: toInt(row.CategoryUID),
      CategoryName: row.CategoryName ?? "",
      HSNSACCode: row.HSNSACCode ?? "",
      PartNumber: row.PartNumber ?? "",
      SKU: row.SKU ?? "",
      Description: row.Description ?? "",
      PrimaryUnitUID: toInt(row.PrimaryUnitUID),
      PrimaryUnitName: row.PrimaryUnitName ?? "",
      MRP: Number(row.MRP ?? 0),
      SellingPrice: Number(row.SellingPrice ?? 0),
      PurchasePrice: Number(row.PurchasePrice ?? 0),
      SellingProductTaxUID: toInt(row.SellingProductTaxUID),
      PurchasePriceProductTaxUID: toInt(row.PurchasePriceProductTaxUID),
      TaxDetailsUID: toInt(row.TaxDetailsUID),
      TaxPercentage: Number(row.TaxPercentage ?? 0),
      CGST: Number(row.CGST ?? 0),
      SGST: Number(row.SGST ?? 0),
      IGST: Number(row.IGST ?? 0),
      AvailableQuantity: Number(row.AvailableQuantity ?? 0),
      Discount: Number(row.Discount ?? 0),
      DiscountTypeUID: toInt(row.DiscountTypeUID),
      LowStockAlertAt: Number(row.LowStockAlertAt ?? 0),
      NotForSale: isNotForSale(row.NotForSale) ? 1 : 0,
      IsComboItem: toInt(row.IsComboItem),
      IsComposite: toInt(row.IsComposite),
      IsSerialTracked: toInt(row.IsSerialTracked),
      IsBrandApplicable: toInt(row.IsBrandApplicable),
      IsSizeApplicable: toInt(row.IsSizeApplicable),
      Image: "",
      Variants: variants.map(({ ProductUID: _product, ...variant }) => variant),
    };
    if (toInt(row.IsComposite)) entry.items = items;
    return entry;
  }

  private async brandEntry(orgUID: number, brand: Row): Promise<Entry> {
    const attachments = await this.masters.findAttachments(orgUID, "Brand", toInt(brand.BrandUID));
    return {
      BrandUID: toInt(brand.BrandUID),
      BrandName: brand.BrandName ?? "",
      BrandCode: brand.BrandCode ?? "",
      Description: brand.Description ?? "",
      Images: attachments.map((attachment) => ({ path: "/" + String(attachment.FilePath ?? "").replace(/^\/+/, ""), name: attachment.FileName })),
    };
  }

  private sizeEntry(size: Row): Entry {
    return {
      SizeUID: toInt(size.SizeUID),
      SizeName: size.SizeName ?? "",
      SizeCode: size.SizeCode ?? "",
      Length: size.Length ?? null,
      Width: size.Width ?? null,
      Height: size.Height ?? null,
      Depth: size.Depth ?? null,
      Diameter: size.Diameter ?? null,
      Thickness: size.Thickness ?? null,
      Weight: size.Weight ?? null,
      DimensionUOM: size.DimensionUOM ?? "",
      WeightUOM: size.WeightUOM ?? "",
      Description: size.Description ?? "",
    };
  }

  private async currentPriceLists(token: string): Promise<PriceListCacheEntry[]> {
    const current = await this.cacheHelper.readOrgValue<PriceListCacheEntry[]>("price-lists", token);
    return Array.isArray(current) ? current : [];
  }

  private async orgToken(orgUID: number): Promise<string> {
    return (await this.orgSettings.get(orgUID)).OrgToken;
  }

  private async safely(label: string, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.logger.warn(`Cache update for ${label} failed: ${(err as Error).message}`);
    }
  }
}
