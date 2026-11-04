import { Injectable } from "@nestjs/common";
import { parseDateTime, phpDate, phpRound, todayDate } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { ExportResult, ExportService, ExportType } from "../../libraries/export/export.service";
import { JournalService } from "../../libraries/journal/journal.service";
import { StockLedgerService } from "../../libraries/stock-ledger/stock-ledger.service";
import { ProductCacheService } from "../products/product-cache.service";
import { InventoryFilter, InventoryRepository } from "./inventory.repository";
import { StockTimelineRepository } from "./stock-timeline.repository";

type Form = Record<string, unknown>;

// Manual stock adjustments are stock movements of module 118 (CI3 "Manual Adj.")
export const MANUAL_ADJUSTMENT_MODULE = 118;
const PRICE_TYPES = ["PurchasePrice", "SellingPrice"];

const EXPORT_HEADERS = ["#", "Item Name", "Category", "Unit", "Qty", "Status", "Purchase Price", "Sale Price", "HSN/SAC", "Last Updated", "Updated By"];
const EXPORT_WIDTHS = ["3%", "18%", "10%", "5%", "5%", "9%", "9%", "9%", "9%", "12%", "11%"];

/**
 * Inventory page (CI3 Inventory controller, module 117): the stock list and stats, manual stock in / out
 * (a StockAdjustmentTbl row, its stock movement and journal), and the product's movement history.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: InventoryRepository,
    private readonly timeline: StockTimelineRepository,
    private readonly stockLedger: StockLedgerService,
    private readonly journal: JournalService,
    private readonly productCache: ProductCacheService,
    private readonly orgSettings: OrgSettingsService,
    private readonly exporter: ExportService
  ) {}

  // index — stats, category filter and the users of the "updated by" filter
  async getPageData(orgUID: number) {
    const [stats, categories, users, settings] = await Promise.all([this.repo.stats(orgUID), this.repo.categories(orgUID), this.repo.orgUsers(orgUID), this.orgSettings.get(orgUID)]);
    return { Stats: stats, Categories: categories, OrgUsers: users, ShowUserFilter: users.length > 1, RowLimit: settings.RowLimit };
  }

  // getPageDetails — the CI3 JS builds the rows from Data
  async getPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: InventoryFilter) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const [rows, total] = await Promise.all([this.repo.list(orgUID, filter, limit, (pageNo - 1) * limit), this.repo.count(orgUID, filter)]);
    return { Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: limit };
  }

  // getStats
  async getStats(orgUID: number) {
    return { Stats: await this.repo.stats(orgUID) };
  }

  /**
   * stockIn / stockOut — the adjustment, its stock movement (moves AvailableQty) and, after the commit, the
   * stock journal and the product's cache entry. Answers with the refreshed stats.
   */
  async adjust(ctx: WriteContext, form: Form, adjType: "IN" | "OUT") {
    const { orgUID, userUID } = ctx;
    const productUID = postInt(form, "ProductUID");
    const variantUID = postInt(form, "VariantUID");
    const quantity = Number(postValue(form, "Qty")) || 0;
    const price = Number(postValue(form, "Price")) || 0;
    const postedPriceType = postString(form, "PriceType");
    const priceType = postedPriceType && PRICE_TYPES.includes(postedPriceType) ? postedPriceType : adjType === "IN" ? "PurchasePrice" : "SellingPrice";
    const stockValue = phpRound(quantity * price, 2);
    const recordDate = postString(form, "RecordDate") || todayDate();
    if (productUID <= 0) throw new CiValidationError("Invalid product.");
    if (quantity <= 0) throw new CiValidationError("Quantity must be greater than zero.");

    const adjUID = await this.db.write.transaction(async (trx) => {
      const uid = await this.repo.insertAdjustment(trx, {
        OrgUID: orgUID,
        ProductUID: productUID,
        VariantUID: variantUID > 0 ? variantUID : null,
        ModuleUID: MANUAL_ADJUSTMENT_MODULE,
        AdjType: adjType,
        Qty: quantity,
        AdjCategory: postString(form, "AdjCategory") || "Miscellaneous",
        Price: price,
        PriceType: priceType,
        StockValue: stockValue,
        RecordDate: recordDate,
        Notes: postString(form, "Notes") || null,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      const applied = await this.stockLedger.apply(trx, {
        orgUID,
        userUID,
        productUID,
        variantUID,
        transUID: uid,
        moduleUID: MANUAL_ADJUSTMENT_MODULE,
        movementType: adjType,
        quantity,
        unitCost: price,
      });
      // The product must be one of the organisation's (CI3 did not check)
      if (!applied) throw new CiValidationError("Invalid product.");
      return uid;
    });

    await this.journal.postAfterSave(`StockAdjustment ${adjUID}`, (trx) => this.journal.postStockAdjustment(trx, orgUID, adjUID, recordDate, adjType, stockValue, userUID));
    await this.productCache.refreshProduct(orgUID, productUID);
    return { Message: adjType === "IN" ? "Stock added successfully." : "Stock removed successfully.", Stats: await this.repo.stats(orgUID) };
  }

  // updateAdj — only the remarks of an adjustment can change
  async updateAdjustment(ctx: WriteContext, form: Form) {
    const adjUID = postInt(form, "AdjUID");
    await this.liveAdjustment(ctx.orgUID, adjUID);
    await this.repo.updateAdjustment(null, ctx.orgUID, adjUID, { Notes: postString(form, "Notes") || null, UpdatedBy: ctx.userUID });
    return { Message: "Remarks updated successfully." };
  }

  // deleteAdj — reverses its stock movement, soft-deletes it, then reverses its journal
  async deleteAdjustment(ctx: WriteContext, form: Form) {
    const adjUID = postInt(form, "AdjUID");
    const adjustment = await this.liveAdjustment(ctx.orgUID, adjUID);
    await this.db.write.transaction(async (trx) => {
      await this.stockLedger.reverse(trx, ctx.orgUID, adjUID, MANUAL_ADJUSTMENT_MODULE, ctx.userUID);
      await this.repo.updateAdjustment(trx, ctx.orgUID, adjUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    });
    await this.journal.postAfterSave(`StockAdjustment ${adjUID} reversal`, (trx) => this.journal.reverse(trx, ctx.orgUID, "StockAdjustment", adjUID, ctx.userUID));
    await this.productCache.refreshProduct(ctx.orgUID, Number(adjustment.ProductUID));
    return { Message: "Stock adjustment deleted successfully.", Stats: await this.repo.stats(ctx.orgUID) };
  }

  // updateLedgerRemarks — remarks on any of the organisation's stock movements
  async updateLedgerRemarks(ctx: WriteContext, form: Form) {
    const ledgerUID = postInt(form, "LedgerUID");
    if (ledgerUID <= 0) throw new CiValidationError("Invalid record.");
    if (!(await this.repo.ledgerRowExists(ctx.orgUID, ledgerUID))) throw new CiValidationError("Record not found or access denied.");
    await this.repo.updateLedgerRemarks(ctx.orgUID, ledgerUID, postString(form, "Remarks") || null, ctx.userUID);
    return { Message: "Remarks updated successfully." };
  }

  // getVariantStock — the brand / size breakdown of a product's stock
  async getVariantStock(orgUID: number, productUID: number) {
    if (productUID <= 0) throw new CiValidationError("Invalid product.");
    return { Variants: await this.repo.variantStock(orgUID, productUID) };
  }

  // getTimeline — a product's last 200 movements
  async getProductTimeline(orgUID: number, productUID: number) {
    if (productUID <= 0) throw new CiValidationError("Invalid product.");
    return { Timeline: await this.timeline.productTimeline(orgUID, productUID) };
  }

  // searchProducts — for the timeline's item filter
  async searchProducts(orgUID: number, term: string, langCode: string) {
    return { Products: await this.repo.searchProducts(orgUID, term.trim(), langCode) };
  }

  // export — the filtered list as CSV, Excel or printable HTML
  async export(orgUID: number, type: ExportType, filter: InventoryFilter): Promise<ExportResult> {
    const [settings, org, rows] = await Promise.all([this.orgSettings.get(orgUID), this.orgSettings.getHeader(orgUID), this.repo.list(orgUID, filter, 0, 0)]);
    return this.exporter.build({
      type,
      fileName: "Inventory_Data",
      sheetName: "Inventory",
      previewName: "Inventory / Stock Report",
      headers: EXPORT_HEADERS,
      rows: rows.map((row, index) => {
        const quantity = Number(row.AvailableQuantity ?? 0);
        const lowAt = Number(row.LowStockAlertAt ?? 0);
        // UpdatedOn is shown as stored (UTC), as CI3 does
        const updatedOn = parseDateTime(row.UpdatedOn as string);
        return [
          index + 1,
          String(row.ItemName ?? ""),
          String(row.CategoryName ?? ""),
          String(row.UnitName ?? ""),
          quantity,
          quantity <= 0 ? "Out of Stock" : lowAt > 0 && quantity <= lowAt ? "Low Stock" : "In Stock",
          String(row.PurchasePrice ?? ""),
          String(row.SellingPrice ?? ""),
          String(row.HSNSACCode ?? ""),
          updatedOn ? phpDate("d M Y, h:i A", updatedOn, "UTC") : "",
          String(row.UpdatedByName ?? ""),
        ];
      }),
      org,
      timezone: settings.Timezone,
      colWidths: EXPORT_WIDTHS,
    });
  }

  private async liveAdjustment(orgUID: number, adjUID: number) {
    if (adjUID <= 0) throw new CiValidationError("Invalid adjustment.");
    const adjustment = await this.repo.adjustment(orgUID, adjUID);
    if (!adjustment) throw new CiValidationError("Adjustment not found or access denied.");
    return adjustment;
  }
}
