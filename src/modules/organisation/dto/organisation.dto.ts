import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";

/**
 * The CI3 organisation form, field for field (same names the CI3 JS posts). Field rules are checked by
 * orgFormValidator with CI3's messages, so properties here are only allowed through, not validated.
 */
export class OrganisationFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "Posted by the CI3 form; the organisation updated is always orgId" }) @Allow() OrgUID?: string | number;
  @ApiPropertyOptional() @Allow() Name?: string;
  @ApiPropertyOptional() @Allow() BrandName?: string;
  @ApiPropertyOptional({ description: "Exactly 3 letters/digits, stored in upper case" }) @Allow() ShortCode?: string;
  @ApiPropertyOptional({ description: "Short description" }) @Allow() Description?: string;
  @ApiPropertyOptional({ example: "+91" }) @Allow() CountryCode?: string;
  @ApiPropertyOptional({ example: "IN" }) @Allow() CountryISO2?: string;
  @ApiPropertyOptional() @Allow() MobileNumber?: string;
  @ApiPropertyOptional({ description: "Validated when posted; not saved (the CI3 form shows it read-only)" }) @Allow() EmailAddress?: string;
  @ApiPropertyOptional() @Allow() GSTIN?: string;
  @ApiPropertyOptional() @Allow() OrgBussTypeUID?: string | number;
  @ApiPropertyOptional() @Allow() OrgIndusTypeUID?: string | number;
  @ApiPropertyOptional() @Allow() OrgBusRegTypeUID?: string | number;
  @ApiPropertyOptional() @Allow() AlternateNumber?: string;
  @ApiPropertyOptional() @Allow() Website?: string;
  @ApiPropertyOptional() @Allow() PANNumber?: string;
  @ApiPropertyOptional() @Allow() TimezoneUID?: string | number;
  @ApiPropertyOptional() @Allow() StateCode?: string;
  @ApiPropertyOptional() @Allow() StateName?: string;

  @ApiPropertyOptional({ description: "Empty = new billing address, > 0 = OrgAddressUID to update" }) @Allow() BillOrgAddressUID?: string | number;
  @ApiPropertyOptional({ description: "The billing address is saved only when this is filled" }) @Allow() BillAddrLine1?: string;
  @ApiPropertyOptional() @Allow() BillAddrLine2?: string;
  @ApiPropertyOptional() @Allow() BillAddrPincode?: string;
  @ApiPropertyOptional() @Allow() BillAddrCity?: string | number;
  @ApiPropertyOptional() @Allow() BillAddrCityText?: string;
  @ApiPropertyOptional() @Allow() BillAddrState?: string | number;
  @ApiPropertyOptional() @Allow() BillAddrStateText?: string;

  @ApiPropertyOptional({
    description: "JSON array of { UID (0 = new), Line1, Line2, Pincode, CityId, CityName, StateId, StateName }",
  })
  @Allow()
  ShipAddresses?: string | Record<string, unknown>[];

  @ApiPropertyOptional({ description: "JSON array of OrgAddressUIDs to remove" }) @Allow() DelShipUIDs?: string | number[];

  @ApiPropertyOptional({ type: "string", format: "binary", description: "New logo image" }) UploadImage?: unknown;
}

// One shipping address (Bill manager's "add / edit dispatch address" modal)
export class ShipAddressDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "Required" }) @Allow() Line1?: string;
  @ApiPropertyOptional() @Allow() Line2?: string;
  @ApiPropertyOptional() @Allow() CityText?: string;
  @ApiPropertyOptional() @Allow() CityId?: string | number;
  @ApiPropertyOptional() @Allow() StateText?: string;
  @ApiPropertyOptional() @Allow() StateId?: string | number;
  @ApiPropertyOptional() @Allow() Pincode?: string;
}

export class ShipAddressUpdateDto extends ShipAddressDto {
  @ApiProperty({ type: Number }) @Allow() OrgAddressUID?: string | number;
}
