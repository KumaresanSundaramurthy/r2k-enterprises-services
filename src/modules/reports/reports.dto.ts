import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { EXPORT_TYPES, ExportType } from "../../libraries/export/export.service";

// Reports over a date range (YYYY-MM-DD; default 1 January → today)
export class ReportRangeDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "2026-01-01", description: "YYYY-MM-DD; default 1 January of this year" }) @Allow() from?: string;
  @ApiPropertyOptional({ example: "2026-12-31", description: "YYYY-MM-DD; default today" }) @Allow() to?: string;
}

// Summaries grouped by period
export class ReportGroupedRangeDto extends ReportRangeDto {
  @ApiPropertyOptional({ enum: ["month", "quarter", "year"], default: "month" }) @Allow() groupby?: string;
}

export class CustomerLedgerDto extends ReportRangeDto {
  @ApiProperty({ type: Number }) @Allow() customerUID?: string | number;
}

export class SupplierLedgerDto extends ReportRangeDto {
  @ApiProperty({ type: Number }) @Allow() vendorUID?: string | number;
}

export class ExportCustomerLedgerDto extends CustomerLedgerDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
  @ApiPropertyOptional() @Allow() langCode?: string;
}

export class ExportSupplierLedgerDto extends SupplierLedgerDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
  @ApiPropertyOptional() @Allow() langCode?: string;
}

export class BankStatementDto extends ReportRangeDto {
  @ApiPropertyOptional({ type: Number, description: "BankAccountUID; 0 or empty = all accounts" }) @Allow() account?: string | number;
}

export class ReportAsOfDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "2026-12-31", description: "YYYY-MM-DD; default today" }) @Allow() asof?: string;
}

export class ReportDateDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "2026-08-29", description: "YYYY-MM-DD; default today" }) @Allow() date?: string;
}

// GSTR-1 / 2B / 3B period (bad or missing values fall back to the current month / year)
export class GstMonthDto extends OrgContextDto {
  @ApiPropertyOptional({ example: 8, description: "1-12; default this month" }) @Allow() month?: string | number;
  @ApiPropertyOptional({ example: 2026, description: "2000-2099; default this year" }) @Allow() year?: string | number;
}

export class ReportYearDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "2026", description: "Calendar year; default this year" }) @Allow() year?: string;
}

export class ExportGstr1Dto extends GstMonthDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
  @ApiProperty({ enum: ["b2b", "b2cs", "cdnr"] }) @Allow() section!: string;
}

export class ExportGstr2bDto extends GstMonthDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
}

export class ExportGstr3bDto extends GstMonthDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
}

const REGISTER_REPORTS = ["invoice", "purchase", "salesReturn", "purchaseReturn", "deliveryChallan"] as const;

export class ExportDateRangeDto extends ReportRangeDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
}

export class ExportRegisterDto extends ReportRangeDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
  @ApiProperty({ enum: REGISTER_REPORTS }) @Allow() report!: string;
}

export class ExportOrgOnlyDto extends OrgContextDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
}

export class ExportAsOfDto extends ReportAsOfDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
}

export class ExportBankStatementDto extends BankStatementDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
}

export class ExportGroupedRangeDto extends ReportGroupedRangeDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
}

export class ExportYearDto extends ReportYearDto {
  @ApiProperty({ enum: EXPORT_TYPES }) @Allow() Type!: ExportType;
}
