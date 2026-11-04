import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { Allow, IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { toJsonObject } from "../../core/dto/transforms";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { EXPORT_TYPES, ExportType } from "../../libraries/export/export.service";

// Field names are the CI3 POST names; the services read them as CI3 does (getPostValue).

class PagedDto extends OrgContextDto {
  @ApiPropertyOptional({ description: "Rows per page; defaults to the organisation's RowLimit setting" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit?: number;

  @ApiPropertyOptional({ type: Number, description: "1-based page number; used when it is not in the path" }) @Allow() PageNo?: string | number;
}

export class InventoryFilterDto {
  @ApiPropertyOptional({ description: "Matches item name or part number" }) @Allow() Search?: string;
  @ApiPropertyOptional({ type: [Number] }) @Allow() CategoryUID?: number[];
  @ApiPropertyOptional({ type: [Number] }) @Allow() ProductUID?: number[];
  @ApiPropertyOptional({ type: [String], description: "Product / Service" }) @Allow() ProductType?: string[];
  @ApiPropertyOptional({ enum: ["LowStock", "Positive", "OutOfStock"] }) @Allow() StockStatus?: string;
  @ApiPropertyOptional({ enum: ["ItemName", "CategoryName", "Qty", "PurchasePrice", "SellingPrice"] }) @Allow() SortBy?: string;
  @ApiPropertyOptional({ enum: ["ASC", "DESC"] }) @Allow() SortDir?: string;
}

export class TimelineFilterDto {
  @ApiPropertyOptional({ type: [Number] }) @Allow() ProductUID?: number[];
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateFrom?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateTo?: string;
  @ApiPropertyOptional({ enum: ["IN", "OUT"] }) @Allow() MovementType?: string;
  @ApiPropertyOptional({ type: [Number] }) @Allow() CategoryUID?: number[];
  @ApiPropertyOptional({ type: [Number], description: "103 Invoice, 105 Purchase, 106 Sales Return, 107 Credit Note, 108 Purchase Return, 118 Manual Adj." })
  @Allow()
  ModuleUID?: number[];
  @ApiPropertyOptional({ type: [Number] }) @Allow() CreatedByUID?: number[];
  @ApiPropertyOptional({ enum: ["ItemName", "Price", "Category", "Date"] }) @Allow() SortBy?: string;
  @ApiPropertyOptional({ enum: ["ASC", "DESC"] }) @Allow() SortDir?: string;
}

export class SerialFilterDto {
  @ApiPropertyOptional({ enum: ["Available", "Sold", "Returned", "Damaged"] }) @Allow() Status?: string;
  @ApiPropertyOptional({ description: "Matches serial number or item name" }) @Allow() search?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() ProductUID?: number;
}

export class InventoryListDto extends PagedDto {
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { Search, CategoryUID[], ProductUID[], ProductType[], StockStatus, SortBy, SortDir }" })
  @IsOptional()
  @Transform(toJsonObject(InventoryFilterDto))
  Filter?: InventoryFilterDto;
}

export class TimelineListDto extends PagedDto {
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { ProductUID[], DateFrom, DateTo, MovementType, CategoryUID[], ModuleUID[], CreatedByUID[], SortBy, SortDir }" })
  @IsOptional()
  @Transform(toJsonObject(TimelineFilterDto))
  Filter?: TimelineFilterDto;
}

export class SerialListDto extends PagedDto {
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { Status, search, ProductUID }" })
  @IsOptional()
  @Transform(toJsonObject(SerialFilterDto))
  Filter?: SerialFilterDto;
}

export class InventoryExportDto extends OrgContextDto {
  @ApiPropertyOptional({ enum: EXPORT_TYPES, default: "CSV", description: "CSV / Excel download a file; Pdf / Print return HtmlData to print" })
  @IsOptional()
  @IsIn(EXPORT_TYPES)
  Type: ExportType = "CSV";

  @ApiPropertyOptional({ type: String, description: "List filter as JSON (same keys as getPageDetails)" }) @Allow() Filter?: string;
}

export class ProductIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() ProductUID?: string | number;
}

export class ProductSearchDto extends OrgLangContextDto {
  @ApiPropertyOptional({ description: "Part of the item name (empty = first 50)" }) @Allow() Term?: string;
}

export class SerialProductSearchDto extends OrgContextDto {
  @ApiPropertyOptional({ description: "Part of the item name (empty = first 50)" }) @Allow() search?: string;
}

export class StockAdjustDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() ProductUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Brand / size variant" }) @Allow() VariantUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() Qty?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Unit price; Qty × Price is the stock value journalled" }) @Allow() Price?: string | number;
  @ApiPropertyOptional({ enum: ["PurchasePrice", "SellingPrice"], description: "Default: PurchasePrice for stock in, SellingPrice for stock out" })
  @Allow()
  PriceType?: string;
  @ApiPropertyOptional({ description: "Default: Miscellaneous" }) @Allow() AdjCategory?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() RecordDate?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
}

export class AdjustmentDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() AdjUID?: string | number;
  @ApiPropertyOptional({ description: "updateAdj: the new remarks" }) @Allow() Notes?: string;
}

export class LedgerRemarksDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() LedgerUID?: string | number;
  @ApiPropertyOptional() @Allow() Remarks?: string;
}

export class SerialAddDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() ProductUID?: string | number;
  @ApiProperty() @Allow() SerialNumber?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
}

export class SerialStatusDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() SerialUID?: string | number;
  @ApiProperty({ enum: ["Available", "Damaged"] }) @Allow() Status?: string;
}
