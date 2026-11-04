import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { Allow, IsInt, IsOptional, Max, Min } from "class-validator";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { toJsonObject } from "../../core/dto/transforms";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";

// Field names are the CI3 POST names; the services read them as CI3 does (getPostValue).

export class PaymentFilterDto {
  @ApiPropertyOptional({ description: "Cancelled = cancelled and deleted payments; otherwise live ones" }) @Allow() Status?: string;
  @ApiPropertyOptional({ enum: ["In", "Out"] }) @Allow() PaymentDirection?: string;
  @ApiPropertyOptional({ enum: ["C", "S"] }) @Allow() PartyType?: string;
  @ApiPropertyOptional({ type: Number, description: "Payment module (110 Payment In, 111 Payment Out)" }) @Allow() ModuleUID?: number;
  @ApiPropertyOptional() @Allow() PaymentSource?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (recorded on)" }) @Allow() DateFrom?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (recorded on)" }) @Allow() DateTo?: string;
  @ApiPropertyOptional({ description: "Matches document number or party name" }) @Allow() Search?: string;
  @ApiPropertyOptional({ type: [Number], description: "Recorded by" }) @Allow() UpdatedByUIDs?: number[];
  @ApiPropertyOptional({ type: [String], description: "Payment type names" }) @Allow() PaymentMode?: string[];
  @ApiPropertyOptional({ type: [Number], description: "Document modules (103 Invoice, 105 Purchase, …)" }) @Allow() DocTypeModuleUIDs?: number[];
  @ApiPropertyOptional({ type: [String], description: "C / S" }) @Allow() PartyTypes?: string[];
  @ApiPropertyOptional({ enum: ["Date", "Amount", "Type", "Party"] }) @Allow() SortBy?: string;
  @ApiPropertyOptional({ enum: ["ASC", "DESC"] }) @Allow() SortDir?: string;
}

export class PaymentListDto extends OrgContextDto {
  @ApiPropertyOptional({ description: "Rows per page; defaults to the organisation's RowLimit setting" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit?: number;

  @ApiPropertyOptional({ type: Number, description: "1-based page number; used when it is not in the path" }) @Allow() PageNo?: string | number;

  @ApiPropertyOptional({ type: String, description: "Filter as JSON (see PaymentFilterDto)" })
  @IsOptional()
  @Transform(toJsonObject(PaymentFilterDto))
  Filter?: PaymentFilterDto;
}

export class TransIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
}

export class PaymentIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() PaymentUID?: string | number;
}

export class PaymentPrintDto extends PaymentIdQueryDto {
  @ApiPropertyOptional({ enum: ["a4", "thermal"], default: "a4" }) @Allow() PrintType?: string;
}

export class PaymentPdfDto extends PaymentIdQueryDto {
  @ApiPropertyOptional({ default: "A4" }) @Allow() PaperSize?: string;
}

export class PartyIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number, description: "CustomerUID" }) @Allow() PartyUID?: string | number;
}

export class BankIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() BankAccountUID?: string | number;
}

export class PaymentDeleteDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() PaymentUID?: string | number;
  @ApiPropertyOptional({ enum: ["delete", "cancel"], default: "delete" }) @Allow() Action?: string;
}

export class PaymentAddDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() ModuleUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() BillTotal?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional() @Allow() ReferenceNo?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() IsFullyPaid?: string | number;
  @ApiPropertyOptional({ enum: ["C", "S"], default: "C" }) @Allow() PartyType?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() PartyUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() AdvanceAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() ExcessSourcePaymentUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() OnAccountAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() OnAccountSourcePaymentUID?: string | number;
}

export class BankSaveDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ type: Number, description: "Update when given" }) @Allow() BankAccountUID?: string | number;
  @ApiProperty() @Allow() AccountName?: string;
  @ApiProperty() @Allow() BankName?: string;
  @ApiProperty() @Allow() AccountNumber?: string;
  @ApiPropertyOptional({ description: "Required (and must match) for a new account" }) @Allow() ConfirmAccountNumber?: string;
  @ApiPropertyOptional() @Allow() IFSC?: string;
  @ApiPropertyOptional() @Allow() BranchName?: string;
  @ApiPropertyOptional() @Allow() UPIId?: string;
  @ApiPropertyOptional() @Allow() UPINumber?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() IsDefault?: string | number;
}

export class BankIdDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() BankAccountUID?: string | number;
}
