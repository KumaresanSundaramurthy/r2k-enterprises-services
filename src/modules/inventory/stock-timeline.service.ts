import { Injectable } from "@nestjs/common";
import { phpDate } from "../../common/utils/php-compat";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { buildDateRange } from "../../core/utils/date-range";
import { ExportResult, ExportService, ExportType } from "../../libraries/export/export.service";
import { InventoryRepository } from "./inventory.repository";
import { MANUAL_ADJUSTMENT_MODULE } from "./inventory.service";
import { StockTimelineRepository, TimelineFilter } from "./stock-timeline.repository";

type Row = Record<string, unknown>;

// Users.UserPreferencesTbl key of the page's saved date filter (CI3 getDateFilterPreference('inventory'))
const DATE_PREFERENCE = "df_inventory";

// Source column of the export, by the movement's module
const MODULE_LABELS: Record<number, string> = {
  103: "Invoice",
  105: "Purchase",
  106: "Sales Return",
  107: "Credit Note",
  108: "Purchase Return",
  [MANUAL_ADJUSTMENT_MODULE]: "Manual Adj.",
};

const EXPORT_HEADERS = ["#", "Date", "Item Name", "Category", "Source", "Reference", "Type", "Qty", "Price", "Remarks", "Created By"];
const EXPORT_WIDTHS = ["3%", "9%", "16%", "9%", "7%", "9%", "7%", "5%", "7%", "16%", "12%"];

// A Y-m-d date in the given PHP format
const showDate = (ymd: unknown, format: string) => (ymd ? phpDate(format, new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`), "UTC") : "");

/** Inventory → Timeline page (CI3 Inventory::timelinePage, module 118): every stock movement of the organisation. */
@Injectable()
export class StockTimelineService {
  constructor(
    private readonly repo: StockTimelineRepository,
    private readonly inventory: InventoryRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly exporter: ExportService
  ) {}

  // timelinePage — category filter and the saved date range (default this month)
  async getPageData(orgUID: number, branchUID: number, userUID: number) {
    const [settings, saved, categories, format] = await Promise.all([
      this.orgSettings.get(orgUID),
      this.repo.preference(orgUID, branchUID, userUID, DATE_PREFERENCE),
      this.inventory.categories(orgUID),
      this.repo.listDateFormat(orgUID),
    ]);
    const range = buildDateRange(saved || "this_month", settings.Timezone);
    return {
      Categories: categories,
      RowLimit: settings.RowLimit,
      DefaultFilter: { DateFrom: range.from, DateTo: range.to },
      SavedDateRange: range.range,
      SavedDateLabel: range.label,
      SavedDateFrom: range.from,
      SavedDateTo: range.to,
      SavedDateFromDisplay: showDate(range.from, format),
      SavedDateToDisplay: showDate(range.to, format),
    };
  }

  // getTimelinePageDetails — the CI3 JS builds the rows from Data
  async getPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: TimelineFilter) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const [rows, total] = await Promise.all([this.repo.list(orgUID, filter, limit, (pageNo - 1) * limit), this.repo.count(orgUID, filter)]);
    return { Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: limit };
  }

  // exportTimeline — every matching movement, newest first
  async export(orgUID: number, type: ExportType, filter: TimelineFilter): Promise<ExportResult> {
    const [settings, org, format, rows] = await Promise.all([
      this.orgSettings.get(orgUID),
      this.orgSettings.getHeader(orgUID),
      this.repo.listDateFormat(orgUID),
      this.repo.list(orgUID, filter, 0, 0),
    ]);
    return this.exporter.build({
      type,
      fileName: "Inventory_Timeline",
      sheetName: "Timeline",
      previewName: "Inventory Stock Timeline",
      headers: EXPORT_HEADERS,
      rows: rows.map((row, index) => StockTimelineService.exportRow(index + 1, row, format)),
      org,
      timezone: settings.Timezone,
      colWidths: EXPORT_WIDTHS,
    });
  }

  // _mapTimelineRow — adjustments show ADJ-{id} and their date, transactions their number and date
  private static exportRow(position: number, row: Row, format: string): (string | number)[] {
    const moduleUID = Number(row.ModuleUID);
    const manual = moduleUID === MANUAL_ADJUSTMENT_MODULE;
    const reference = manual
      ? Number(row.AdjUID) > 0
        ? `ADJ-${Number(row.AdjUID)}`
        : String(row.AdjCategory || "Manual")
      : String(row.UniqueNumber || row.TransNumber || "—");
    const date = manual ? showDate(row.AdjDate, format) || "—" : showDate(row.TransDate, format) || "—";
    return [
      position,
      date,
      String(row.ItemName ?? ""),
      String(row.CategoryName ?? ""),
      MODULE_LABELS[moduleUID] ?? "Unknown",
      reference,
      String(row.MovementType ?? ""),
      String(row.Quantity ?? ""),
      String(row.SellingPrice ?? row.UnitCost ?? ""),
      String(row.Remarks ?? "—"),
      String(row.CreatedByName ?? ""),
    ];
  }
}
