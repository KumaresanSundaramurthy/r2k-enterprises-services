import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { parseDateTime, phpDate, smartDecimal, toInt } from "../../common/utils/php-compat";
import { ExportResult, ExportService } from "../../libraries/export/export.service";
import { CustomerExportDto } from "./dto/customer-list.dto";
import { CustomersRepository } from "./customers.repository";

const HEADERS = [
  "#",
  "Customer Name",
  "Area",
  "Mobile",
  "Email",
  "GSTIN",
  "Company Name",
  "Customer Type",
  "Balance",
  "Balance Type",
  "Status",
  "Last Updated",
  "Updated By",
];
const COL_WIDTHS = ["3%", "14%", "9%", "9%", "12%", "9%", "9%", "8%", "7%", "6%", "5%", "9%", "10%"];
const DEFAULT_DATE_FORMAT = "d M Y";

// exportCustomers (CI3 Customers::exportCustomers) — the filtered customer list as CSV, Excel or printable HTML.
@Injectable()
export class CustomerExportService {
  constructor(
    private readonly customers: CustomersRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly exporter: ExportService
  ) {}

  async export(dto: CustomerExportDto): Promise<ExportResult> {
    const [settings, org, list] = await Promise.all([
      this.orgSettings.get(dto.orgId),
      this.orgSettings.getHeader(dto.orgId),
      this.customers.listPaginated(dto.orgId, 0, 0, dto.Filter ?? {}, dto.langCode),
    ]);
    const dateFormat = settings.ListDateTimeFormat ?? DEFAULT_DATE_FORMAT;

    const rows = list.rows.map((row, index) => {
      // CI3 formats UpdatedOn as stored, without a timezone conversion
      const updatedOn = parseDateTime(row.UpdatedOn);
      return [
        index + 1,
        row.Name ?? "",
        row.Area ?? "",
        row.MobileNumber ?? "",
        row.EmailAddress ?? "",
        row.GSTIN ?? "",
        row.CompanyName ?? "",
        row.CustomerTypeName ?? "",
        smartDecimal(row.ClosingBalance ?? 0),
        row.ClosingBalanceType ?? "",
        toInt(row.IsActive ?? 1) === 1 ? "Active" : "Inactive",
        updatedOn ? phpDate(dateFormat, updatedOn) : "",
        row.UpdatedBy ?? "",
      ];
    });

    return this.exporter.build({
      type: dto.Type,
      fileName: "Customer_Data",
      sheetName: "Customers",
      previewName: "Customer Report",
      headers: HEADERS,
      rows,
      org,
      timezone: settings.Timezone,
      colWidths: COL_WIDTHS,
    });
  }
}
