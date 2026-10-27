import { ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgContextDto } from "../../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";
import { CustomerFormDto } from "./customer-form.dto";

// Values are checked by the service so the messages match CI3.

export class CustomerUpdateDto extends CustomerFormDto {
  @ApiPropertyOptional({ type: Number }) @Allow() CustomerUID?: string | number;
  @ApiPropertyOptional({ description: "Non-empty = remove the customer image" }) @Allow() ImageRemoved?: string | number;
  @ApiPropertyOptional({ description: "1 = soft-delete the bank rows in delBankData" }) @Allow() delBankDataFlag?: string | number;
  @ApiPropertyOptional({ type: [Number], description: "CustBankDetUIDs to delete" }) @Allow() delBankData?: (string | number)[] | string | number;
  @ApiPropertyOptional({ description: "1 = soft-delete the addresses in delAddrData" }) @Allow() delAddrDetailFlag?: string | number;
  @ApiPropertyOptional({ type: [Number], description: "CustAddressUIDs to delete" }) @Allow() delAddrData?: (string | number)[] | string | number;
}

export class CustomerIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() CustomerUID?: string | number;
}

export class CustomerStatusDto extends CustomerIdDto {
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsActive?: string | number;
}

export class CustomerOpeningBalanceSaveDto extends CustomerIdDto {
  @ApiPropertyOptional({ type: Number }) @Allow() OpeningBalance?: string | number;
  @ApiPropertyOptional({ enum: ["Debit", "Credit"] }) @Allow() BalanceType?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number, description: "Year the financial year starts in; defaults to the current (April) FY" })
  @Allow()
  FinancialYear?: string | number;
}

export class ApplyOnAccountDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() PaymentUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Invoice (TransUID) to apply the payment to" }) @Allow() TransUID?: string | number;
}

export class CustomerNoteDto extends CustomerIdDto {
  @ApiPropertyOptional() @Allow() Note?: string;
}

export class BillingAddressDto extends CustomerIdDto {
  @ApiPropertyOptional() @Allow() Line1?: string;
  @ApiPropertyOptional() @Allow() Line2?: string;
  @ApiPropertyOptional() @Allow() Pincode?: string;
  @ApiPropertyOptional() @Allow() CityId?: string | number;
  @ApiPropertyOptional() @Allow() CityText?: string;
  @ApiPropertyOptional() @Allow() StateId?: string | number;
  @ApiPropertyOptional() @Allow() StateText?: string;
}

export class CustomerBulkDeleteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: [Number], description: "Customers to delete (when SelectAll is not 1)" })
  @Allow()
  CustomerUIDs?: (string | number)[] | string | number;

  @ApiPropertyOptional({ description: "1 = delete every customer matching Filter" }) @Allow() SelectAll?: string | number;

  @ApiPropertyOptional({ description: "List filter (object or JSON string) used with SelectAll" })
  @Allow()
  Filter?: string | Record<string, unknown>;
}

export class CustomerAttachmentsDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() CustomerUID?: string | number;
}

// deleteCustomerAttachment — CustomerUID (optional) also refreshes the customer's primary image
export class CustomerAttachmentDeleteDto extends CustomerIdDto {
  @ApiPropertyOptional({ type: Number }) @Allow() AttachUID?: string | number;
}
