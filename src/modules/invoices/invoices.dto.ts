import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { TransChangeDto, TransFormDto, TransFormQueryDto } from "../transactions/transaction-form.dto";

// Customer document forms that can take payments with them (invoices, sales returns)
export class SalesPaidFormDto extends TransFormDto {
  @ApiPropertyOptional({ type: Number, description: "1 = save the PaymentRows (a saved, non-draft document)" }) @Allow() RecordPayment?: string | number;
  @ApiPropertyOptional({ description: "JSON array: { paymentTypeUID, amount, bankAccountUID, referenceNo, notes, paymentDate }" }) @Allow() PaymentRows?: string;
  @ApiPropertyOptional({ type: Number, description: "0 / 1 (stored on the last payment row)" }) @Allow() IsFullyPaid?: string | number;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "PaymentFiles[] — files of the first payment row" }) PaymentFiles?: unknown;
}

export class InvoiceFormDto extends SalesPaidFormDto {
  @ApiPropertyOptional({ description: "Document type" }) @Allow() invoiceType?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() dueDate?: string;
  @ApiPropertyOptional({ type: Number, description: "A Pending credit note paying the invoice (a draft only reserves it)" }) @Allow() CreditNoteUID?: string | number;
  @ApiPropertyOptional({ description: "addInvoice: JSON array [{ PaymentUID, ApplyAmount }] of the customer's on-account payments to use" }) @Allow() OnAccountApplyJson?: string;
  @ApiPropertyOptional({ type: Number, description: "addInvoice: the sales order it was made from (marked Converted)" }) @Allow() fromSalesOrderUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "addInvoice: the quotation it was made from (marked Converted)" }) @Allow() fromQuotationUID?: string | number;
}

export class InvoiceFormQueryDto extends TransFormQueryDto {
  @ApiPropertyOptional({ description: "Edit by the invoice's edit-link token (instead of TransUID)" }) @Allow() Token?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() fromSalesOrder?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() fromQuotation?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() fromProForma?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() fromChallan?: string | number;
}

export class InvoiceDeleteDto extends TransChangeDto {
  @ApiPropertyOptional({ enum: ["credit_note", "refund", "cancel_only"], description: "What happens to payments received (else the organisation's InvoiceCancelAction)" })
  @Allow()
  CancelPaymentAction?: string;
}

export class InvoiceStatusDto extends InvoiceDeleteDto {
  @ApiProperty({ enum: ["Issued", "Paid", "Partial", "Cancelled"] }) @Allow() Status?: string;
  @ApiPropertyOptional({ description: "Stored when cancelling" }) @Allow() CancelReason?: string;
}

export class InvoicePaymentDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Cash / bank amount" }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Advance (another payment's excess) to use" }) @Allow() AdvanceAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() ExcessSourcePaymentUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "On-account credit to use" }) @Allow() OnAccountAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() OnAccountSourcePaymentUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional() @Allow() ReferenceNo?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "PaymentFiles[] (up to 3, 3 MB each)" }) PaymentFiles?: unknown;
}

export class CreditNoteActionDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() CreditNoteUID?: string | number;
  @ApiPropertyOptional({ description: "cancelCreditNote: stored as CancelReason" }) @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number, description: "applyCreditNote: the invoice it pays" }) @Allow() TransUID?: string | number;
}

export class CustomerIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() CustomerUID?: string | number;
}

export class CreditNotesListDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional({ type: Number, default: 10 }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ enum: ["All", "Pending", "Applied", "Refunded"] }) @Allow() Status?: string;
  @ApiPropertyOptional({ description: "Matches the note number, customer name or source document number" }) @Allow() Search?: string;
}

export class SalesDocQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
}
