import { ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgContextDto, OrgLangContextDto } from "../../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";

// The CI3 forms, field for field. Values are checked by the services so the messages match CI3.

export class ProductFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Required on update" }) @Allow() ProductUID?: string | number;
  @ApiPropertyOptional() @Allow() ItemName?: string;
  @ApiPropertyOptional({ enum: ["Product", "Service"] }) @Allow() ProductType?: string;
  @ApiPropertyOptional() @Allow() MRP?: string | number;
  @ApiPropertyOptional() @Allow() SellingPrice?: string | number;
  @ApiPropertyOptional({ description: "ProductTaxUID; 1 = price includes tax" }) @Allow() SellingTaxOption?: string | number;
  @ApiPropertyOptional({ description: "TaxDetailsUID" }) @Allow() TaxPercentage?: string | number;
  @ApiPropertyOptional({ description: "PrimaryUnitUID" }) @Allow() PrimaryUnit?: string | number;
  @ApiPropertyOptional({ description: "CategoryUID" }) @Allow() Category?: string | number;
  @ApiPropertyOptional() @Allow() HSNCode?: string;
  @ApiPropertyOptional() @Allow() PurchasePrice?: string | number;
  @ApiPropertyOptional() @Allow() PurchaseTaxOption?: string | number;
  @ApiPropertyOptional() @Allow() PartNumber?: string;
  @ApiPropertyOptional({ description: "HTML (Quill)" }) @Allow() Description?: string;
  @ApiPropertyOptional() @Allow() OpeningQuantity?: string | number;
  @ApiPropertyOptional() @Allow() OpeningPurchasePrice?: string | number;
  @ApiPropertyOptional() @Allow() OpeningStockValue?: string | number;
  @ApiPropertyOptional() @Allow() Discount?: string | number;
  @ApiPropertyOptional({ description: "DiscountTypeUID" }) @Allow() DiscountOption?: string | number;
  @ApiPropertyOptional() @Allow() LowStockAlert?: string | number;
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() NotForSale?: string | number;
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsRentable?: string | number;
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsSizeApplicable?: string | number;
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsBrandApplicable?: string | number;
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsSerialTracked?: string | number;
  @ApiPropertyOptional({ description: "Used when storage is enabled in the settings" }) @Allow() StorageUID?: string | number;
  @ApiPropertyOptional() @Allow() BrandUID?: string | number;
  @ApiPropertyOptional() @Allow() Standard?: string;
  @ApiPropertyOptional({
    description: "JSON array of { BrandUID, SizeUID, PartNumber, PurchasePrice, PurchaseTaxUID, SellingPrice, SellingTaxUID, OpeningQty } (size / brand products)",
  })
  @Allow()
  VariantData?: string;
  @ApiPropertyOptional() @Allow() rc_SecurityDeposit?: string | number;
  @ApiPropertyOptional() @Allow() rc_HourlyRate?: string | number;
  @ApiPropertyOptional() @Allow() rc_HalfDayRate?: string | number;
  @ApiPropertyOptional() @Allow() rc_FullDayRate?: string | number;
  @ApiPropertyOptional() @Allow() rc_FixedPackageRate?: string | number;
  @ApiPropertyOptional() @Allow() rc_ExtraHourRate?: string | number;
  @ApiPropertyOptional() @Allow() rc_LateReturnCharge?: string | number;
  @ApiPropertyOptional() @Allow() rc_DamagePenaltyRate?: string | number;
  @ApiPropertyOptional() @Allow() rc_MinRentalHours?: string | number;
  @ApiPropertyOptional({ description: "Comma-separated AttachUIDs to delete (images are sent as ProdAttachFiles[] files)" })
  @Allow()
  ProdAttachDeleteUIDs?: string;
}

export class ComboFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Required on edit" }) @Allow() ComboUID?: string | number;
  @ApiPropertyOptional() @Allow() ComboName?: string;
  @ApiPropertyOptional() @Allow() ComboSellingPrice?: string | number;
  @ApiPropertyOptional() @Allow() ComboPurchasePrice?: string | number;
  @ApiPropertyOptional() @Allow() ComboMRP?: string | number;
  @ApiPropertyOptional({ description: "TaxDetailsUID" }) @Allow() ComboTaxPercentage?: string | number;
  @ApiPropertyOptional({ description: "1 = price includes tax" }) @Allow() ComboSellingTaxOption?: string | number;
  @ApiPropertyOptional() @Allow() ComboPurchaseTaxOption?: string | number;
  @ApiPropertyOptional() @Allow() ComboPrimaryUnit?: string | number;
  @ApiPropertyOptional() @Allow() ComboDescription?: string;
  @ApiPropertyOptional({ description: "JSON array of { ItemUID, Qty } — at least 2 components" }) @Allow() ComboComponentsData?: string;
  @ApiPropertyOptional({ description: "1 = also return the groups page and stats" }) @Allow() getTableDetails?: string | number;
  @ApiPropertyOptional() @Allow() PageNo?: string | number;
  @ApiPropertyOptional() @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ description: "Groups list filter (JSON) used with getTableDetails" }) @Allow() Filter?: string | Record<string, unknown>;
}

export class ProductIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() ProductUID?: string | number;
}

export class ProductStatusDto extends ProductIdDto {
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsActive?: string | number;
}

export class ProductBulkDeleteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: [Number], description: "ProductUIDs[] (when SelectAll is not 1)" }) @Allow() ProductUIDs?: (string | number)[] | string | number;
  @ApiPropertyOptional({ description: "1 = delete every item matching Filter" }) @Allow() SelectAll?: string | number;
  @ApiPropertyOptional({ description: "Items list filter (JSON) used with SelectAll" }) @Allow() Filter?: string | Record<string, unknown>;
}

export class ComboIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() ComboUID?: string | number;
}

// Read endpoints keyed by one id (query string)
export class ProductQueryDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() ProductUID?: string | number;
}

export class ItemQueryDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number, description: "ProductUID" }) @Allow() ItemUID?: string | number;
}

export class ComboQueryDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() ComboUID?: string | number;
}

export class CategoryQueryDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() CategoryUID?: string | number;
}

export class BrandQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() BrandUID?: string | number;
}

export class PriceListQueryDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number, description: "PriceListUID" }) @Allow() uid?: string | number;
}

export class CategoryFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Required on update" }) @Allow() CategoryUID?: string | number;
  @ApiPropertyOptional() @Allow() CategoryName?: string;
  @ApiPropertyOptional() @Allow() CategoryDescription?: string;
  @ApiPropertyOptional({ description: "Comma-separated AttachUIDs to delete (images are sent as CatgAttachFiles[] files)" })
  @Allow()
  CatgAttachDeleteUIDs?: string;
}

export class CategoryIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() CategoryUID?: string | number;
}

export class CategoryBulkDeleteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: [Number], description: "CategoryUIDs[]" }) @Allow() CategoryUIDs?: (string | number)[] | string | number;
}

export class BrandFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Required on update" }) @Allow() BrandUID?: string | number;
  @ApiPropertyOptional() @Allow() BrandName?: string;
  @ApiPropertyOptional() @Allow() BrandCode?: string;
  @ApiPropertyOptional() @Allow() Description?: string;
  @ApiPropertyOptional({ description: "Comma-separated AttachUIDs to delete (images are sent as BrandAttachFiles[] files)" })
  @Allow()
  BrandAttachDeleteUIDs?: string;
}

export class BrandIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() BrandUID?: string | number;
}

export class BrandBulkDeleteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: [Number], description: "BrandUIDs[]" }) @Allow() BrandUIDs?: (string | number)[] | string | number;
}

export class SizeFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Required on update" }) @Allow() SizeUID?: string | number;
  @ApiPropertyOptional() @Allow() SizeName?: string;
  @ApiPropertyOptional() @Allow() SizeCode?: string;
  @ApiPropertyOptional() @Allow() Length?: string | number;
  @ApiPropertyOptional() @Allow() Width?: string | number;
  @ApiPropertyOptional() @Allow() Height?: string | number;
  @ApiPropertyOptional() @Allow() Depth?: string | number;
  @ApiPropertyOptional() @Allow() Diameter?: string | number;
  @ApiPropertyOptional() @Allow() Thickness?: string | number;
  @ApiPropertyOptional() @Allow() Weight?: string | number;
  @ApiPropertyOptional() @Allow() DimensionUOM?: string;
  @ApiPropertyOptional() @Allow() WeightUOM?: string;
  @ApiPropertyOptional() @Allow() Description?: string;
}

export class SizeIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() SizeUID?: string | number;
}

export class SizeBulkDeleteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: [Number], description: "SizeUIDs[]" }) @Allow() SizeUIDs?: (string | number)[] | string | number;
}

export class QuickSizeDto extends OrgUserContextDto {
  @ApiPropertyOptional() @Allow() SizeName?: string;
}

export class EntityAttachmentsDto extends OrgContextDto {
  @ApiPropertyOptional({ enum: ["Product", "Category", "Brand"] }) @Allow() EntityType?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() EntityUID?: string | number;
}

export class EntityAttachmentsSaveDto extends OrgUserContextDto {
  @ApiPropertyOptional({ enum: ["Product", "Category", "Brand"] }) @Allow() EntityType?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() EntityUID?: string | number;
}

export class EntityAttachmentDeleteDto extends EntityAttachmentsSaveDto {
  @ApiPropertyOptional({ type: Number }) @Allow() AttachUID?: string | number;
}

export class PriceListFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "0 / absent = new price list" }) @Allow() PLUID?: string | number;
  @ApiPropertyOptional() @Allow() Name?: string;
  @ApiPropertyOptional() @Allow() Description?: string;
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() Status?: string | number;
  @ApiPropertyOptional() @Allow() Priority?: string | number;
  @ApiPropertyOptional({ example: "2026-11-01" }) @Allow() ValidFrom?: string;
  @ApiPropertyOptional({ example: "2027-03-31" }) @Allow() ValidTo?: string;
  @ApiPropertyOptional({ enum: ["All", "Groups", "Customers"] }) @Allow() AssignedToType?: string;
  @ApiPropertyOptional({ enum: ["All", "Specific"] }) @Allow() Scope?: string;
  @ApiPropertyOptional({ example: "SellingPrice" }) @Allow() GlobalBasedOn?: string;
  @ApiPropertyOptional({ description: "JSON array of { CustomerTypeUID, DiscountType, DiscountValue } (Scope All)" }) @Allow() Discounts?: string;
  @ApiPropertyOptional({ description: "JSON array of { ProductUID, VariantUID?, MinQty, MaxQty, CustomerTypeUID, Price } (Scope Specific)" })
  @Allow()
  Rules?: string;
  @ApiPropertyOptional({ description: "JSON array of group / customer UIDs (AssignedToType Groups / Customers)" }) @Allow() Assignments?: string;
  @ApiPropertyOptional({ description: "Price lists page to return" }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional() @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ description: "Price lists filter (JSON)" }) @Allow() Filter?: string | Record<string, unknown>;
}

export class PriceListDeleteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() PriceListUID?: string | number;
  @ApiPropertyOptional() @Allow() PageNo?: string | number;
  @ApiPropertyOptional() @Allow() RowLimit?: string | number;
  @ApiPropertyOptional() @Allow() Filter?: string | Record<string, unknown>;
}

export class PriceListBulkDeleteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "Comma-separated PriceListUIDs" }) @Allow() PriceListUIDs?: string;
  @ApiPropertyOptional() @Allow() PageNo?: string | number;
  @ApiPropertyOptional() @Allow() RowLimit?: string | number;
  @ApiPropertyOptional() @Allow() Filter?: string | Record<string, unknown>;
}

export class RecalcStockDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "0 / absent = every product of the organisation" }) @Allow() ProductUID?: string | number;
}
