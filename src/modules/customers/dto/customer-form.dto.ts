import { ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgUserBranchContextDto } from "../../../core/dto/write-context.dto";

/**
 * The CI3 customer form, field for field (same names the CI3 JS posts). Field rules are checked by
 * CustomerFormValidator with CI3's messages, so properties here are only allowed through, not validated.
 */
export class CustomerFormDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional() @Allow() Name?: string;
  @ApiPropertyOptional() @Allow() Area?: string;
  @ApiPropertyOptional({ example: "+91" }) @Allow() CountryCode?: string;
  @ApiPropertyOptional({ example: "IN" }) @Allow() CountryISO2?: string;
  @ApiPropertyOptional() @Allow() MobileNumber?: string;
  @ApiPropertyOptional() @Allow() EmailAddress?: string;
  @ApiPropertyOptional({ enum: ["Debit", "Credit"], description: "Opening balance type" }) @Allow() DebitCreditCheck?: string;
  @ApiPropertyOptional({ description: "Opening balance amount" }) @Allow() DebitCreditAmount?: string | number;
  @ApiPropertyOptional() @Allow() PANNumber?: string;
  @ApiPropertyOptional() @Allow() ContactPerson?: string;
  @ApiPropertyOptional({ description: "Contact person's date of birth, YYYY-MM-DD" }) @Allow() CPDateOfBirth?: string;
  @ApiPropertyOptional() @Allow() GSTIN?: string;
  @ApiPropertyOptional() @Allow() CompanyName?: string;
  @ApiPropertyOptional() @Allow() WorkPhone?: string;
  @ApiPropertyOptional() @Allow() LandlineNumber?: string;
  @ApiPropertyOptional() @Allow() DiscountPercent?: string | number;
  @ApiPropertyOptional() @Allow() CreditPeriod?: string | number;
  @ApiPropertyOptional() @Allow() CreditLimit?: string | number;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: [String], description: "Array or comma-separated" }) @Allow() Tags?: string | string[];
  @ApiPropertyOptional({ type: [String], description: "Array or comma-separated" }) @Allow() CCEmails?: string | string[];
  @ApiPropertyOptional() @Allow() AllowPortalAccess?: string | number | boolean;
  @ApiPropertyOptional() @Allow() GSTINValidated?: string | number | boolean;
  @ApiPropertyOptional() @Allow() CustomerTypeUID?: string | number;
  @ApiPropertyOptional() @Allow() SalutationUID?: string | number;
  @ApiPropertyOptional({ description: "Group to add the customer to (0 = none)" }) @Allow() GroupUID?: string | number;

  @ApiPropertyOptional({
    description: 'JSON array (or array) of { id: "New-1" | <CustBankDetUID>, type, accNumber, ifsc, branch, holder, upiId }',
  })
  @Allow()
  BankDetailsJSON?: string | Record<string, unknown>[];

  @ApiPropertyOptional({ description: "0 = new billing address, > 0 = CustAddressUID to update" }) @Allow() BillAddressUID?: string | number;
  @ApiPropertyOptional() @Allow() BillAddrLine1?: string;
  @ApiPropertyOptional() @Allow() BillAddrLine2?: string;
  @ApiPropertyOptional() @Allow() BillAddrPincode?: string;
  @ApiPropertyOptional() @Allow() BillAddrCity?: string | number;
  @ApiPropertyOptional() @Allow() BillAddrCityText?: string;
  @ApiPropertyOptional() @Allow() BillAddrState?: string | number;
  @ApiPropertyOptional() @Allow() BillAddrStateText?: string;

  @ApiPropertyOptional({ description: "0 = new shipping address, > 0 = CustAddressUID to update" }) @Allow() ShipAddressUID?: string | number;
  @ApiPropertyOptional() @Allow() ShipAddrLine1?: string;
  @ApiPropertyOptional() @Allow() ShipAddrLine2?: string;
  @ApiPropertyOptional() @Allow() ShipAddrPincode?: string;
  @ApiPropertyOptional() @Allow() ShipAddrCity?: string | number;
  @ApiPropertyOptional() @Allow() ShipAddrCityText?: string;
  @ApiPropertyOptional() @Allow() ShipAddrState?: string | number;
  @ApiPropertyOptional() @Allow() ShipAddrStateText?: string;

  @ApiPropertyOptional({ description: "1 = also return page 1 of the list and the stats" }) @Allow() returnList?: string | number;

  @ApiPropertyOptional({ description: "Comma-separated AttachUIDs to delete (images are sent as CustAttachFiles[] files)" })
  @Allow()
  CustAttachDeleteUIDs?: string;
}
