import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { parseDateTime, phpDate, smartDecimal, toInt } from "../../common/utils/php-compat";
import { ExportResult, ExportService } from "../../libraries/export/export.service";
import { VendorExportDto } from "./dto/vendor-list.dto";
import { VendorsRepository } from "./vendors.repository";

const HEADERS = ["#", "Vendor Name", "Area", "Mobile", "Email", "GSTIN", "Company Name", "Balance", "Balance Type", "Status", "Last Updated", "Updated By"];
const COL_WIDTHS = ["3%", "16%", "10%", "10%", "13%", "9%", "9%", "8%", "7%", "5%", "9%", "10%"];
const DEFAULT_DATE_FORMAT = "d M Y";

// exportVendors (CI3 Vendors::exportVendors) — the filtered vendor list as CSV, Excel or printable HTML.
@Injectable()
export class VendorExportService {
  constructor(
    private readonly vendors: VendorsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly exporter: ExportService
  ) {}

  async export(dto: VendorExportDto): Promise<ExportResult> {
    const [settings, org, list] = await Promise.all([
      this.orgSettings.get(dto.orgId),
      this.orgSettings.getHeader(dto.orgId),
      this.vendors.listPaginated(dto.orgId, 0, 0, dto.Filter ?? {}, dto.langCode),
    ]);
    const dateFormat = settings.ListDateTimeFormat ?? DEFAULT_DATE_FORMAT;

    const rows = list.rows.map((row, index) => {
      // UpdatedOn is stored in UTC and shown in the organisation's timezone (as CI3 does for vendors)
      const updatedOn = parseDateTime(row.UpdatedOn);
      return [
        index + 1,
        row.Name ?? "",
        row.Area ?? "",
        row.MobileNumber ?? "",
        row.EmailAddress ?? "",
        row.GSTIN ?? "",
        row.CompanyName ?? "",
        smartDecimal(row.ClosingBalance ?? 0),
        row.ClosingBalanceType ?? "Credit",
        toInt(row.IsActive ?? 1) === 1 ? "Active" : "Inactive",
        updatedOn ? phpDate(dateFormat, updatedOn, settings.Timezone) : "",
        row.UpdatedBy ?? "",
      ];
    });

    return this.exporter.build({
      type: dto.Type,
      fileName: "Vendor_Data",
      sheetName: "Vendors",
      previewName: "Vendor Report",
      headers: HEADERS,
      rows,
      org,
      timezone: settings.Timezone,
      colWidths: COL_WIDTHS,
    });
  }
}
