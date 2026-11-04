import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { Allow, IsInt, IsOptional, Min } from "class-validator";
import { OrgContextDto, OrgPagedListDto } from "../../core/dto/org-context.dto";
import { toJsonObject } from "../../core/dto/transforms";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";

// DTOs both pages share. Field names are the CI3 POST names; the services read them as CI3 does (getPostValue).

class EntryFilterDto {
  @ApiPropertyOptional({ description: "All (default) or one status" }) @Allow() Status?: string;
  @ApiPropertyOptional({ type: [String], description: "Several statuses (overrides Status)" }) @Allow() StatusList?: string[];
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateFrom?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateTo?: string;
  @ApiPropertyOptional({ description: "Matches number, category or notes" }) @Allow() Name?: string;
  @ApiPropertyOptional({ type: [Number] }) @Allow() PaymentTypeUIDs?: number[];
  @ApiPropertyOptional({ type: [Number] }) @Allow() UpdatedByUIDs?: number[];
}

export class EntryExpenseFilterDto extends EntryFilterDto {
  @ApiPropertyOptional({ type: [Number] }) @Allow() CategoryUIDs?: number[];
}

// The list's branch (CI3 JwtData->Org->BranchUID)
class BranchListDto extends OrgPagedListDto {
  @ApiProperty({ type: Number, example: 1, description: "BranchUID the user is currently working in" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId!: number;

  @ApiPropertyOptional({ type: Number, description: "1-based page number; used when it is not in the path" }) @Allow() PageNo?: string | number;
}

export class EntryListDto extends BranchListDto {
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { Status, StatusList[], DateFrom, DateTo, Name, CategoryUIDs[] (expenses), PaymentTypeUIDs[], UpdatedByUIDs[] }" })
  @IsOptional()
  @Transform(toJsonObject(EntryExpenseFilterDto))
  Filter?: EntryExpenseFilterDto;

  @ApiPropertyOptional({ description: "Expenses: 1 adds SummaryStats" }) @Allow() ShowStats?: string | number;
}

// Changes that answer with the refreshed first page take the list's Filter / RowLimit / ShowStats
export class EntryChangeDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ description: "JSON filter of the list (for the returned first page)" }) @Allow() Filter?: string;
  @ApiPropertyOptional() @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ description: "Expenses: 1 adds SummaryStats to the returned page" }) @Allow() ShowStats?: string | number;
}

export class EntryTransDto extends OrgContextDto {
  @ApiProperty({ type: Number, description: "ExpenseUID / IncomeUID" }) @Allow() TransUID?: string | number;
}

export class EntryPaymentDto extends EntryChangeDto {
  @ApiProperty({ type: Number, description: "ExpenseUID / IncomeUID" }) @Allow() TransUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Empty = the cash account" }) @Allow() BankAccountUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default: the record's date)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional() @Allow() ReferenceNo?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "PaymentFiles[]: up to 3 files (pdf, image, Word, Excel), 3 MB each" })
  PaymentFiles?: unknown;
}

export class EntryCategoryListDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional() @Allow() Search?: string;
}

export class EntryCategorySaveDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ type: Number, description: "updateCategory only" }) @Allow() CategoryUID?: string | number;
  @ApiProperty() @Allow() CategoryName?: string;
  @ApiPropertyOptional({ type: Number, description: "Manager page to return (expenses)" }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional({ description: "Manager search to return (expenses)" }) @Allow() Search?: string;
}

export class EntryCategoryIdDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() CategoryUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional() @Allow() Search?: string;
}

export class EntryBulkDeleteDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ type: Number, description: "1 = every record matching Filter" }) @Allow() SelectAll?: string | number;
  @ApiPropertyOptional({ description: "JSON filter (with SelectAll)" }) @Allow() Filter?: string;
}

// Record attachments of a create / update (AttachFiles[] or Attachments[])
export const ATTACH_FILES_PROPERTY = {
  type: "array",
  items: { type: "string", format: "binary" },
  description: "AttachFiles[] (or Attachments[])",
} as const;
