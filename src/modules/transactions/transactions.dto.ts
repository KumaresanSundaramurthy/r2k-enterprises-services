import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { Allow, IsInt, IsOptional, Max, Min } from "class-validator";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { toJsonObject } from "../../core/dto/transforms";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";

// Field names are the CI3 POST names; the services read them as CI3 does (getPostValue).

export class TransFilterDto {
  @ApiPropertyOptional({ description: "Tab: All (default), Open, Accepted, Converted, Cancelled, Draft, …" }) @Allow() Status?: string;
  @ApiPropertyOptional({ description: "Matches customer name / mobile or the document number" }) @Allow() Name?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (with DateTo)" }) @Allow() DateFrom?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (with DateFrom)" }) @Allow() DateTo?: string;
  @ApiPropertyOptional({ type: [String], description: "Several statuses (Pending, Accepted, Converted, Draft, Cancelled, Rejected)" }) @Allow() StatusList?: string[];
  @ApiPropertyOptional({ type: Number }) @Allow() MinAmount?: number;
  @ApiPropertyOptional({ type: Number }) @Allow() MaxAmount?: number;
  @ApiPropertyOptional({ enum: ["Paid", "Partially Paid", "Pending"] }) @Allow() PaymentStatus?: string;
  @ApiPropertyOptional({ description: "Payment type name" }) @Allow() PaymentMode?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() PartyUID?: number;
  @ApiPropertyOptional({ type: [Number] }) @Allow() UpdatedByUIDs?: number[];
  @ApiPropertyOptional({ enum: ["Date", "Amount", "Number"] }) @Allow() SortBy?: string;
  @ApiPropertyOptional({ enum: ["ASC", "DESC"] }) @Allow() SortDir?: string;
}

export class TransListDto extends OrgLangContextDto {
  @ApiProperty({ type: Number, example: 1, description: "BranchUID the user is currently working in" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId!: number;

  @ApiPropertyOptional({ description: "Rows per page; defaults to the organisation's RowLimit setting" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit?: number;

  @ApiPropertyOptional({ type: Number, description: "1-based page number; used when it is not in the path" }) @Allow() PageNo?: string | number;

  @ApiPropertyOptional({ type: String, description: "Filter as JSON (see TransFilterDto)" })
  @IsOptional()
  @Transform(toJsonObject(TransFilterDto))
  Filter?: TransFilterDto;
}

export class TransDetailDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiProperty({ type: Number, example: 101 }) @Allow() ModuleUID?: string | number;
  @ApiPropertyOptional({ enum: ["a4", "thermal", "view"], default: "a4" }) @Allow() PrintType?: string;
}

export class TransAttachmentsDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "114 Expense, 115 Indirect Income, otherwise a transaction" }) @Allow() ModuleUID?: string | number;
}

export class TransBulkDeleteDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ type: Number, description: "1 = every document matching Filter" }) @Allow() SelectAll?: string | number;
  @ApiPropertyOptional({ description: "JSON filter (with SelectAll)" }) @Allow() Filter?: string;
  @ApiPropertyOptional({ type: [Number], description: "TransUIDs (array, JSON array or comma list) when not SelectAll" }) @Allow() TransUIDs?: unknown;
}

export class CustomerSearchDto extends OrgLangContextDto {
  @ApiPropertyOptional({ description: "Matches name, area, mobile, GSTIN, company or contact person" }) @Allow() term?: string;
}

export class ProductSearchDto extends OrgLangContextDto {
  @ApiPropertyOptional({ description: "Matches item name or part number" }) @Allow() term?: string;
  @ApiPropertyOptional({ type: Number, description: "Category filter" }) @Allow() categuid?: string | number;
}

export class PrefixSaveDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ type: Number, description: "Update / delete / set default: the prefix" }) @Allow() prePrefixUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Add: the module (101 Quotation, 102 Sales Order, …)" }) @Allow() preModuleUID?: string | number;
  @ApiPropertyOptional({ description: "2–7 characters" }) @Allow() transPrefixName?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() includeFiscalYear?: string | number;
  @ApiPropertyOptional({ enum: ["SHORT", "LONG"] }) @Allow() fiscalYearFormat?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() includeShortName?: string | number;
  @ApiPropertyOptional({ description: "Required with includeShortName (1–10 characters)" }) @Allow() companyShortName?: string;
  @ApiPropertyOptional({ enum: ["-", "/", "|", "_", "."] }) @Allow() prefixSeparator?: string;
  @ApiPropertyOptional({ enum: ["1", "3", "5"] }) @Allow() numberPadding?: string | number;
}
