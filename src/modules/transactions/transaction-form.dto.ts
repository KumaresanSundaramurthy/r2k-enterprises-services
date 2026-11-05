import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgLangContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";

// The transaction form fields every document type posts (CI3 POST names); document DTOs extend these.

export class TransPageDataDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ description: "Initial tab slug (all, open, …)" }) @Allow() tab?: string;
  @ApiPropertyOptional({ description: "Initial search text" }) @Allow() search?: string;
}

export class TransFormQueryDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number, description: "Edit form: the document (empty = new)" }) @Allow() TransUID?: string | number;
}

// Changes that answer with the refreshed list take the list's PageNo / RowLimit / Filter
export class TransChangeDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ description: "JSON filter of the list (for the returned page)" }) @Allow() Filter?: string;
}

export class TransStatusDto extends TransChangeDto {
  @ApiProperty() @Allow() Status?: string;
}

// Fields of every document form; the customer forms add customerSearch, the vendor forms vendorSearch
export class TransFormBaseDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ type: Number, description: "Update only" }) @Allow() TransUID?: string | number;
  @ApiProperty({ type: Number, description: "PrefixUID (not needed for a draft)" }) @Allow() transPrefixSelect?: string | number;
  @ApiProperty({ type: Number }) @Allow() transNumber?: string | number;
  @ApiProperty({ description: "YYYY-MM-DD" }) @Allow() transDate?: string;
  @ApiPropertyOptional({ enum: ["save", "draft"], default: "save" }) @Allow() action?: string;
  @ApiProperty({
    description:
      "JSON array of lines: { id, itemName, quantity, unitPrice, taxPercent, cgstPercent, sgstPercent, igstPercent, line_total, net_total, " +
      "taxAmount, cgstAmount, sgstAmount, igstAmount, discount, discount_amount, discountTypeUID, taxDetailsUID, primaryUnit, categoryUID, " +
      "storageUID, brandUID, variantUID, … }",
  })
  @Allow()
  Items?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() SubTotal?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() DiscountAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() TaxAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() CgstAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() SgstAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() IgstAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() AdditionalChargesTotal?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() RoundOff?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() GlobalDiscPercent?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() globalDiscount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() extraDiscount?: string | number;
  @ApiPropertyOptional() @Allow() extDiscountType?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() NetAmount?: string | number;
  @ApiPropertyOptional({ description: "JSON array: { chargeUID, chargeName, chargeDisplayName, inPercent, withoutTaxAmount, taxUID, taxPercent, taxAmount, withTaxAmount, sortOrder }" })
  @Allow()
  AdditionalCharges?: string;
  @ApiPropertyOptional({ type: Number, description: "0 / 1" }) @Allow() isInterState?: string | number;
  @ApiPropertyOptional() @Allow() placeOfSupplyCode?: string;
  @ApiPropertyOptional() @Allow() placeOfSupplyName?: string;
  @ApiPropertyOptional() @Allow() referenceDetails?: string;
  @ApiPropertyOptional() @Allow() transNotes?: string;
  @ApiPropertyOptional() @Allow() transTermsCond?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() SignatureUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() PriceListUID?: string | number;
  @ApiPropertyOptional() @Allow() PriceListData?: string;
  @ApiPropertyOptional({ description: "Update: JSON array (or comma list) of removed AttachUIDs" }) @Allow() RemovedAttachIDs?: string;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "AttachFiles[] (or Attachments[])" }) AttachFiles?: unknown;
}

export class TransFormDto extends TransFormBaseDto {
  @ApiProperty({ type: Number, description: "CustomerUID" }) @Allow() customerSearch?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Dispatch-from OrgAddressUID" }) @Allow() dispatchFrom?: string | number;
}

export class VendorTransFormDto extends TransFormBaseDto {
  @ApiProperty({ type: Number, description: "VendorUID" }) @Allow() vendorSearch?: string | number;
}
