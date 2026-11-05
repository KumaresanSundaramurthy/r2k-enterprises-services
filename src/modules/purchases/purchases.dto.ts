import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Allow, IsOptional } from "class-validator";
import { toJsonObject } from "../../core/dto/transforms";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { TransChangeDto, TransFormQueryDto, VendorTransFormDto } from "../transactions/transaction-form.dto";

// Bill / return forms: the payments posted with a new document (PaymentRows) — Purchases and Purchase Returns
export class VendorDocumentFormDto extends VendorTransFormDto {
  @ApiPropertyOptional({ description: "Document type" }) @Allow() purchaseType?: string;
  @ApiPropertyOptional({ type: Number, description: "Dispatch-to OrgAddressUID" }) @Allow() dispatchTo?: string | number;
  @ApiPropertyOptional({ type: Number, description: "1 = save the PaymentRows (a saved, non-draft document)" }) @Allow() RecordPayment?: string | number;
  @ApiPropertyOptional({ description: "JSON array: { paymentTypeUID, amount, bankAccountUID, referenceNo, notes, paymentDate }" }) @Allow() PaymentRows?: string;
  @ApiPropertyOptional({ type: Number, description: "0 / 1 (stored on the last payment row)" }) @Allow() IsFullyPaid?: string | number;
}

export class PurchaseFormDto extends VendorDocumentFormDto {
  @ApiPropertyOptional({ description: "YYYY-MM-DD (bill due date)" }) @Allow() billDueDate?: string;
  @ApiPropertyOptional() @Allow() supplierInvoiceNo?: string;
  @ApiPropertyOptional({ type: Number, description: "1 = update the products' purchase price from PriceChangedItems" }) @Allow() UpdatePurchasePrices?: string | number;
  @ApiPropertyOptional({ description: "JSON array: { productUID, newPrice }" }) @Allow() PriceChangedItems?: string;
}

export class PurchaseFormQueryDto extends TransFormQueryDto {
  @ApiPropertyOptional({ type: Number, description: "New form pre-filled from this purchase order" }) @Allow() fromPurchaseOrder?: string | number;
}

// Delete / cancel: what happens to payments already made (else the organisation's PurchaseCancelAction)
export class PurchaseDeleteDto extends TransChangeDto {
  @ApiPropertyOptional({ enum: ["debit_note", "refund"] }) @Allow() CancelPaymentAction?: string;
}

export class PurchaseStatusDto extends PurchaseDeleteDto {
  @ApiProperty({ enum: ["Received", "Paid", "Cancelled"], description: "Draft → Received; Received → Paid / Cancelled; Paid → Cancelled" }) @Allow() Status?: string;
  @ApiPropertyOptional({ description: "Stored when cancelling" }) @Allow() CancelReason?: string;
}

export class PurchasePaymentDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ type: Number, description: "A Pending vendor debit note to use as well" }) @Allow() DebitNoteUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() DebitNoteAmount?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional() @Allow() ReferenceNo?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number, description: "The list page to return" }) @Allow() CurrentPage?: string | number;
  @ApiPropertyOptional({ description: "JSON filter of the list" }) @Allow() Filter?: string;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "PaymentFiles[] (up to 3, 3 MB each)" }) PaymentFiles?: unknown;
}

export class ApplyDebitNoteDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() DebitNoteUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() CurrentPage?: string | number;
  @ApiPropertyOptional() @Allow() Filter?: string;
}

export class DebitNoteIdDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() DebitNoteUID?: string | number;
}

export class VendorIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() VendorUID?: string | number;
}

export class PurchaseDocQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
}

export class DebitNotesListDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional({ type: Number, default: 10 }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ enum: ["All", "Pending", "Applied", "Refunded"] }) @Allow() Status?: string;
  @ApiPropertyOptional({ description: "Matches the source document number or vendor name" }) @Allow() Search?: string;
}

export class VendorPaymentFilterDto {
  @ApiPropertyOptional({ enum: ["Cancelled"], description: "Cancelled = cancelled / deleted payments" }) @Allow() Status?: string;
  @ApiPropertyOptional() @Allow() PaymentSource?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (payment created on)" }) @Allow() DateFrom?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateTo?: string;
  @ApiPropertyOptional({ description: "Matches the bill number or vendor name" }) @Allow() Search?: string;
  @ApiPropertyOptional({ type: [Number] }) @Allow() UpdatedByUIDs?: number[];
  @ApiPropertyOptional({ type: [String], description: "Payment type names" }) @Allow() PaymentMode?: string[];
  @ApiPropertyOptional({ type: [Number] }) @Allow() DocTypeModuleUIDs?: number[];
  @ApiPropertyOptional({ enum: ["Date", "Amount", "Type", "Party"] }) @Allow() SortBy?: string;
  @ApiPropertyOptional({ enum: ["ASC", "DESC"] }) @Allow() SortDir?: string;
}

export class VendorPaymentsListDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional({ type: Number, default: 10 }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ type: String, description: "Filter as JSON (see VendorPaymentFilterDto)" })
  @IsOptional()
  @Transform(toJsonObject(VendorPaymentFilterDto))
  Filter?: VendorPaymentFilterDto;
}
