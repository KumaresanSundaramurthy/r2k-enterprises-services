import { ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgContextDto, OrgLangContextDto } from "../../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";
import { VendorFormDto } from "./vendor-form.dto";

// Values are checked by the services so the messages match CI3.

export class VendorUpdateDto extends VendorFormDto {
  @ApiPropertyOptional({ type: Number }) @Allow() VendorUID?: string | number;
  @ApiPropertyOptional({ description: "Non-empty = remove the vendor image" }) @Allow() ImageRemoved?: string | number;
  @ApiPropertyOptional({ description: "1 = soft-delete the bank rows in delBankData" }) @Allow() delBankDataFlag?: string | number;
  @ApiPropertyOptional({ type: [Number], description: "VendBankDetUIDs to delete" }) @Allow() delBankData?: (string | number)[] | string | number;
  @ApiPropertyOptional({ description: "1 = soft-delete the addresses in delAddrData" }) @Allow() delAddrDetailFlag?: string | number;
  @ApiPropertyOptional({ type: [Number], description: "VendAddressUIDs to delete" }) @Allow() delAddrData?: (string | number)[] | string | number;
}

export class VendorIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() VendorUID?: string | number;
}

export class VendorStatusDto extends VendorIdDto {
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsActive?: string | number;
}

export class VendorBulkDeleteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: [Number], description: "Vendors to delete (VendorUIDs[] in a form post; when SelectAll is not 1)" })
  @Allow()
  VendorUIDs?: (string | number)[] | string | number;

  @ApiPropertyOptional({ description: "1 = delete every vendor matching Filter" }) @Allow() SelectAll?: string | number;

  @ApiPropertyOptional({ description: "List filter (JSON string or object) used with SelectAll" })
  @Allow()
  Filter?: string | Record<string, unknown>;
}

export class VendorOpeningBalanceSaveDto extends VendorIdDto {
  @ApiPropertyOptional({ type: Number }) @Allow() OpeningBalance?: string | number;
  @ApiPropertyOptional({ enum: ["Debit", "Credit"] }) @Allow() BalanceType?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number, description: "Year the financial year starts in; defaults to the current (April) FY" })
  @Allow()
  FinancialYear?: string | number;
}

export class VendorOpeningBalanceDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() VendorUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Year the financial year starts in, e.g. 2026; defaults to the current (April) FY" })
  @Allow()
  FinancialYear?: string | number;
}

export class VendorNoteDto extends VendorIdDto {
  @ApiPropertyOptional() @Allow() Note?: string;
}

export class VendorBillingAddressDto extends VendorIdDto {
  @ApiPropertyOptional() @Allow() Line1?: string;
  @ApiPropertyOptional() @Allow() Line2?: string;
  @ApiPropertyOptional() @Allow() Pincode?: string;
  @ApiPropertyOptional() @Allow() CityId?: string | number;
  @ApiPropertyOptional() @Allow() CityText?: string;
  @ApiPropertyOptional() @Allow() StateId?: string | number;
  @ApiPropertyOptional() @Allow() StateText?: string;
}

export class VendorAttachmentsDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() VendorUID?: string | number;
}

// deleteVendorAttachment — VendorUID (optional) also refreshes the vendor's primary image
export class VendorAttachmentDeleteDto extends VendorIdDto {
  @ApiPropertyOptional({ type: Number }) @Allow() AttachUID?: string | number;
}

// getVendorStatementTab — dates YYYY-MM-DD, default the current month
export class VendorStatementDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() VendorUID?: string | number;
  @ApiPropertyOptional({ example: "2026-10-01" }) @Allow() FromDate?: string;
  @ApiPropertyOptional({ example: "2026-10-31" }) @Allow() ToDate?: string;
}

// loadModalForm — add / edit / clone form data
export class VendorModalFormDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number, description: "VendorUID for edit / clone" }) @Allow() uid?: string | number;
}
