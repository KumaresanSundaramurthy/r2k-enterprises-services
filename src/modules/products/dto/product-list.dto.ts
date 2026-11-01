import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsArray, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateNested } from "class-validator";
import { OrgLangContextDto } from "../../../core/dto/org-context.dto";
import { toArray, toJsonObject, toOptionalNumber } from "../../../core/dto/transforms";

// Filter keys are the same as the CI3 product page posts (Filter[...]). A sort key applies when present.

const toIntArray = ({ value }: { value: unknown }) => {
  const list = toArray({ value }) as unknown[] | undefined;
  return list?.map((item) => parseInt(String(item), 10)).filter((item) => !Number.isNaN(item));
};

class LastUpdatedFilter {
  @ApiPropertyOptional({ type: [Number], description: "UserUIDs who last updated the row" })
  @IsOptional()
  @Transform(toIntArray)
  @IsArray()
  LastUpdatedFilter?: number[];
}

// Items / Groups tabs (CI3 itemFilterFormation)
export class ProductListFilterDto extends LastUpdatedFilter {
  @ApiPropertyOptional({ description: "Matches ItemName, HSNSACCode or PartNumber" }) @IsOptional() @IsString() SearchAllData?: string;
  @ApiPropertyOptional({ type: [String], description: "Product / Service" }) @IsOptional() @Transform(toArray) @IsArray() ProductType?: string[];
  @ApiPropertyOptional({ type: [Number], description: "CategoryUIDs" }) @IsOptional() @Transform(toIntArray) @IsArray() Category?: number[];
  @ApiPropertyOptional({ type: [Number], description: "StorageUIDs" }) @IsOptional() @Transform(toIntArray) @IsArray() Storage?: number[];
  @ApiPropertyOptional({ type: [Number], description: "IsActive values (0 / 1)" }) @IsOptional() @Transform(toIntArray) @IsArray() StatusFilter?: number[];
  @ApiPropertyOptional({ type: [Number], description: "TaxDetailsUIDs" }) @IsOptional() @Transform(toIntArray) @IsArray() Tax?: number[];
  @ApiPropertyOptional({ description: "1 = ascending, other = descending" }) @IsOptional() @Transform(toOptionalNumber) NameSorting?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) StatusSorting?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) CategorySorting?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) QtySorting?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) MRPSorting?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) SellingPriceSorting?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) PurchasePriceSorting?: number;
}

// Categories / Brands tabs (CI3 catgFilterFormation / brandFilterFormation)
export class CategoryListFilterDto extends LastUpdatedFilter {
  @ApiPropertyOptional() @IsOptional() @IsString() SearchAllData?: string;
  @ApiPropertyOptional({ description: "1 = A→Z, other = Z→A" }) @IsOptional() @Transform(toOptionalNumber) NameSorting?: number;
  @ApiPropertyOptional({ type: [Number], description: "Only rows used by these ProductUIDs" }) @IsOptional() @Transform(toIntArray) @IsArray() ProductFilter?: number[];
}

// Sizes tab (CI3 sizeFilterFormation)
export class SizeListFilterDto extends LastUpdatedFilter {
  @ApiPropertyOptional({ description: "Matches the size name" }) @IsOptional() @IsString() SearchAllData?: string;
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) NameSorting?: number;
}

// Price Lists tab (CI3 Pricelists_model::getPriceListPaginated)
export class PriceListFilterDto extends LastUpdatedFilter {
  @ApiPropertyOptional({ description: "Matches the price list name" }) @IsOptional() @IsString() SearchAllData?: string;
  @ApiPropertyOptional({ type: [Number] }) @IsOptional() @Transform(toIntArray) @IsArray() StatusFilter?: number[];
  @ApiPropertyOptional({ type: [String], description: "All / Groups / Customers" }) @IsOptional() @Transform(toArray) @IsArray() AssignedToFilter?: string[];
  @ApiPropertyOptional({ type: [String], description: "All / Specific" }) @IsOptional() @Transform(toArray) @IsArray() ScopeFilter?: string[];
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) NameSorting?: number;
  @ApiPropertyOptional() @IsOptional() @Transform(toOptionalNumber) StatusSorting?: number;
}

// Query parameters every list takes after orgId (OrgContextDto) and the path's pageNo
class PagedListDto {
  @ApiPropertyOptional({ type: Number, description: "Rows per page; defaults to the organisation's RowLimit setting" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit?: number;

  @ApiPropertyOptional({ example: "en", description: "UI language code; 'en' (default) returns the base text" })
  @IsOptional()
  @Matches(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, { message: "langCode must be a language code such as 'en' or 'ta'" })
  langCode: string = "en";
}

export class ProductListDto extends PagedListDto {
  @ApiPropertyOptional({
    type: String,
    description:
      "Filter as JSON: SearchAllData, ProductType[], Category[], Storage[], StatusFilter[], Tax[], LastUpdatedFilter[], " +
      "NameSorting, StatusSorting, CategorySorting, QtySorting, MRPSorting, SellingPriceSorting, PurchasePriceSorting",
  })
  @IsOptional()
  @Transform(toJsonObject(ProductListFilterDto))
  @ValidateNested()
  Filter?: ProductListFilterDto;
}

export class CategoryListDto extends PagedListDto {
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: SearchAllData, NameSorting, ProductFilter[], LastUpdatedFilter[]" })
  @IsOptional()
  @Transform(toJsonObject(CategoryListFilterDto))
  @ValidateNested()
  Filter?: CategoryListFilterDto;
}

export class SizeListDto extends PagedListDto {
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: SearchAllData, NameSorting, LastUpdatedFilter[]" })
  @IsOptional()
  @Transform(toJsonObject(SizeListFilterDto))
  @ValidateNested()
  Filter?: SizeListFilterDto;
}

export class PriceListListDto extends PagedListDto {
  @ApiPropertyOptional({
    type: String,
    description: "Filter as JSON: SearchAllData, StatusFilter[], AssignedToFilter[], ScopeFilter[], LastUpdatedFilter[], NameSorting, StatusSorting",
  })
  @IsOptional()
  @Transform(toJsonObject(PriceListFilterDto))
  @ValidateNested()
  Filter?: PriceListFilterDto;
}

// getItemsForBOM — combo component search
export class BomSearchDto extends OrgLangContextDto {
  @ApiPropertyOptional({ description: "Part of the item name" }) @IsOptional() @IsString() search?: string;
}

// getDropdownCache — the lookup lists of the product form
export class DropdownCacheDto extends OrgLangContextDto {
  @ApiPropertyOptional({
    type: [String],
    description: "primaryUnit, discType, prodType, prodTax, taxDetails, categories, brands (all when omitted)",
  })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  fields?: string[];
}
