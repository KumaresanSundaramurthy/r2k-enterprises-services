import { Injectable } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { phpDate, smartDecimal } from "../../common/utils/php-compat";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { ActivityLogRepository, AuditFilter } from "../activity-log/activity-log.repository";
import { CustomerListFilterDto } from "../customers/dto/customer-list.dto";
import { CustomersRepository } from "../customers/customers.repository";
import { TransactionsRepository, TransFilter } from "../transactions/transactions.repository";
import { VendorListFilterDto } from "../vendors/dto/vendor-list.dto";
import { VendorsRepository } from "../vendors/vendors.repository";
import { DATE_COLUMNS, EXPORT_CONFIGS, EXPORT_FORMATS, EXPORT_LABELS, ExportFormat, MONEY_COLUMNS } from "./export-config";
import { ExportsRepository, GroupExportFilter } from "./exports.repository";
import { ListExportRenderer, ListExportTable } from "./list-export.renderer";

type Row = Record<string, unknown>;

// CI3 Exports::exportData answered with an HTTP status besides the message (the download JS only checks the status)
export class ExportRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export type ExportOutput = { kind: "print"; html: string } | { kind: "file"; fileName: string; contentType: string; body: Buffer };

export interface ExportRequest {
  orgUID: number;
  userUID: number;
  branchUID: number;
  moduleUID: number;
  format: string;
  filter: Record<string, unknown>;
}

// Activity log exports stop at this many rows (CI3 getAuditLogs limit)
const AUDIT_EXPORT_LIMIT = 5000;

// 'YYYY-MM-DD[ HH:MM:SS]' (or a Date) → the same wall-clock time as a UTC Date; null when not a date
function wallClock(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value));
  if (!match) return null;
  const [, y, m, d, h = "0", i = "0", s = "0"] = match;
  return new Date(Date.UTC(+y, +m - 1, +d, +h, +i, +s));
}

// BIT / tinyint flag as 1 or 0 (a missing flag counts as active, as in CI3)
function flag(value: unknown): number {
  if (value === undefined || value === null) return 1;
  if (Buffer.isBuffer(value)) return value[0] ? 1 : 0;
  return Number(value) ? 1 : 0;
}

/**
 * List exports of CI3 (Exports controller + TransactionExporter library): one endpoint for the document lists, customers,
 * customer groups, vendors, products and the activity log, as CSV, Excel, PDF or a printable page.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly repo: ExportsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly transactions: TransactionsRepository,
    private readonly customers: CustomersRepository,
    private readonly vendors: VendorsRepository,
    private readonly activity: ActivityLogRepository
  ) {}

  async export(request: ExportRequest): Promise<ExportOutput> {
    const format = request.format as ExportFormat;
    if (!request.moduleUID || !EXPORT_FORMATS.includes(format)) throw new ExportRequestError("Invalid export request.", 400);
    const config = EXPORT_CONFIGS[request.moduleUID];
    if (!config) throw new ExportRequestError("Export config not found for this module.", 404);

    const settings = await this.orgSettings.get(request.orgUID);
    const [header, langCode, dateFormat] = await Promise.all([
      this.orgSettings.getHeader(request.orgUID),
      this.repo.userLanguage(request.orgUID, request.userUID),
      this.repo.listDateFormat(request.orgUID),
    ]);
    const rows = this.withComputedColumns(request.moduleUID, await this.fetchRows(request, langCode));

    const columns = config.formats[format];
    const now = new Date();
    const table: ListExportTable = {
      title: config.title,
      orgName: String(header?.Name ?? ""),
      exportedOn: phpDate("d M Y", now, settings.Timezone),
      labels: columns.map((column) => EXPORT_LABELS[column] ?? column),
      rows: rows.map((row) => columns.map((column) => ExportsService.cell(row, column, dateFormat))),
      money: columns.map((column) => MONEY_COLUMNS.has(column)),
    };
    const fileName = (ext: string) => `${config.title}_${phpDate("Y-m-d", now, settings.Timezone)}.${ext}`;

    switch (format) {
      case "print":
        return { kind: "print", html: ListExportRenderer.printHtml(table) };
      case "csv":
        return { kind: "file", fileName: fileName("csv"), contentType: "text/csv; charset=UTF-8", body: ListExportRenderer.csv(table) };
      case "excel":
        return { kind: "file", fileName: fileName("xls"), contentType: "application/vnd.ms-excel", body: ListExportRenderer.excel(table) };
      case "pdf":
        return { kind: "file", fileName: fileName("pdf"), contentType: "application/pdf", body: await ListExportRenderer.pdf(table) };
    }
  }

  // _fetchRows — the page's own list query with its filters. Document lists stay in the user's branch, like the list.
  private async fetchRows(request: ExportRequest, langCode: string): Promise<Row[]> {
    const { orgUID, moduleUID, filter } = request;
    if (moduleUID < 200) return this.transactions.exportRows(orgUID, moduleUID, { ...(filter as TransFilter), BranchUID: request.branchUID });
    switch (moduleUID) {
      case 201: {
        const result = await this.customers.listPaginated(orgUID, 1, 0, plainToInstance(CustomerListFilterDto, filter), langCode);
        return result.rows.map((row) => ({ ...row, CustName: row.Name ?? "" }));
      }
      case 202: {
        const result = await this.vendors.listPaginated(orgUID, 1, 0, plainToInstance(VendorListFilterDto, filter), langCode);
        return result.rows.map((row) => ({ ...row, VendName: row.Name ?? "" }));
      }
      case 203:
        return this.repo.products(orgUID, langCode);
      case 204:
        return this.repo.customerGroups(orgUID, filter as GroupExportFilter, langCode);
      case 700:
        return this.activity.logs(orgUID, filter as AuditFilter, AUDIT_EXPORT_LIMIT, 0);
      default:
        return [];
    }
  }

  // Documents: the balance still due; masters: Active / Inactive
  private withComputedColumns(moduleUID: number, rows: Row[]): Row[] {
    if (moduleUID < 200) return rows.map((row) => ({ ...row, BalanceAmount: Math.max(0, Number(row.NetAmount ?? 0) - Number(row.PaidAmount ?? 0)) }));
    return rows.map((row) => ({ ...row, IsActiveLabel: flag(row.IsActive) === 1 ? "Active" : "Inactive" }));
  }

  // _cell — dates in the list date format, money via smartDecimal, everything else as text
  private static cell(row: Row, column: string, dateFormat: string): string {
    const value = row[column];
    if (value === null || value === undefined || value === "") return MONEY_COLUMNS.has(column) ? "0" : "";
    if (DATE_COLUMNS.has(column)) {
      const date = wallClock(value);
      return date ? phpDate(dateFormat, date, "UTC") : String(value);
    }
    if (MONEY_COLUMNS.has(column)) return smartDecimal(Number(value));
    return String(value);
  }
}
