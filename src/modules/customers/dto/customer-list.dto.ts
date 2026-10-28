import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateNested } from "class-validator";
import { OrgLangContextDto } from "../../../core/dto/org-context.dto";
import { toArray, toJsonObject } from "../../../core/dto/transforms";
import { EXPORT_TYPES, ExportType } from "../../../libraries/export/export.service";

// Filter keys are the same as the CI3 list page posts (Filter[...]).
export class CustomerListFilterDto {
  @ApiPropertyOptional({ description: "Matches Name, Area, MobileNumber or ContactPerson" })
  @IsOptional()
  @IsString()
  SearchAllData?: string;

  @ApiPropertyOptional({ type: [String], description: "Customers having any of these tags" })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  Tags?: string[];

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  CustomerTypeUIDs?: number[];

  @ApiPropertyOptional({ type: [Number], description: "UserUIDs who last updated the customer" })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  UpdatedByUIDs?: number[];

  @ApiPropertyOptional({ enum: ["Debit", "Credit"], description: "Debit = to collect, Credit = to pay" })
  @IsOptional()
  @IsIn(["Debit", "Credit"])
  BalanceType?: "Debit" | "Credit";

  @ApiPropertyOptional({ enum: [0, 1] })
  @IsOptional()
  @Type(() => Number)
  @IsIn([0, 1])
  IsActive?: number;

  @ApiPropertyOptional({ description: "1 = A→Z, any other value = Z→A" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  NameSorting?: number;

  @ApiPropertyOptional({ description: "1 = A→Z, any other value = Z→A" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  AreaSorting?: number;

  @ApiPropertyOptional({ description: "1 = low→high, any other value = high→low" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  BalanceSorting?: number;
}

// getCustomersPageDetails query parameters after orgId (OrgContextDto) and the path's pageNo
export class CustomerListDto {
  @ApiPropertyOptional({ type: Number, description: "Rows per page; defaults to the organisation's RowLimit setting" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit?: number;

  @ApiPropertyOptional({
    type: String,
    description:
      "List filter as JSON: SearchAllData, Tags[], CustomerTypeUIDs[], UpdatedByUIDs[], BalanceType (Debit / Credit), " +
      "IsActive (0 / 1), NameSorting, AreaSorting, BalanceSorting",
  })
  @IsOptional()
  @Transform(toJsonObject(CustomerListFilterDto))
  @ValidateNested()
  Filter?: CustomerListFilterDto;

  @ApiPropertyOptional({ example: "en", description: "UI language code; 'en' (default) returns the base text" })
  @IsOptional()
  @Matches(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, { message: "langCode must be a language code such as 'en' or 'ta'" })
  langCode: string = "en";
}

export class CustomerSearchListDto extends OrgLangContextDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PageNo: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit: number = 20;

  @ApiPropertyOptional({ description: "Matches Name, Area, MobileNumber or ContactPerson" })
  @IsOptional()
  @IsString()
  Search?: string;
}

export class SearchCustomersDto extends OrgLangContextDto {
  @ApiPropertyOptional({ description: "Typeahead text (Name, Area or MobileNumber)" })
  @IsOptional()
  @IsString()
  term?: string;

  @ApiPropertyOptional({ description: "Group being edited (0 = new group): customers in other groups are left out" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  groupUID: number = 0;
}

// exportCustomers — every customer matching the list filter (no paging)
export class CustomerExportDto extends OrgLangContextDto {
  @ApiPropertyOptional({ enum: EXPORT_TYPES, default: "CSV", description: "CSV / Excel download a file; Pdf / Print return HtmlData to print" })
  @IsOptional()
  @IsIn(EXPORT_TYPES)
  Type: ExportType = "CSV";

  @ApiPropertyOptional({ type: CustomerListFilterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerListFilterDto)
  Filter?: CustomerListFilterDto;
}
