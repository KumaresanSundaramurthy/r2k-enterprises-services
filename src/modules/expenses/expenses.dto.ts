import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { ATTACH_FILES_PROPERTY, EntryBulkDeleteDto, EntryChangeDto } from "../expense-income/entry.dto";

// Field names are the CI3 POST names of the expense form; the service reads them as CI3 does (getPostValue).

export class ExpenseIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() ExpenseUID?: string | number;
}

export class ExpenseFormQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number, description: "Edit form: the expense (empty = new expense)" }) @Allow() ExpenseUID?: string | number;
}

export class ExpenseSaveDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ type: Number, description: "updateExpense only" }) @Allow() ExpenseUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() ExpenseDate?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() CategoryUID?: string | number;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number, description: "1 = with tax: Items lines and a vendor" }) @Allow() TaxApplicable?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Without tax: the expense amount" }) @Allow() SimpleAmount?: string | number;
  @ApiPropertyOptional({
    description: "With tax, JSON: [{ ExpItemUID (edit), CategoryUID, ItemDescription, Amount, TaxPercentage, TaxAmount, CGSTAmount, SGSTAmount, IGSTAmount, TotalAmount }]",
  })
  @Allow()
  Items?: string;
  @ApiPropertyOptional({ description: "Edit: JSON array of removed ExpItemUIDs" }) @Allow() DeletedItemUIDs?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() TaxPercentage?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() VendorUID?: string | number;
  @ApiPropertyOptional() @Allow() SupplierInvoiceDate?: string;
  @ApiPropertyOptional() @Allow() SupplierInvoiceSerialNo?: string;
  @ApiPropertyOptional({ enum: ["NetAmount", "TotalAmount"] }) @Allow() AmountType?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() TDSApplicable?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() TdsSectionUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() TDSPercentage?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() RCMApplicable?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() RCMAmount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() RoundOff?: string | number;
  @ApiPropertyOptional({ type: Number, description: "addExpense: 1 = paid now (payment fields required)" }) @Allow() IsPaid?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Empty = the cash account" }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default: the expense date)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional() @Allow() PaymentNotes?: string;
  @ApiPropertyOptional({ description: "Edit: JSON array (or comma list) of removed attachment AttachUIDs" }) @Allow() RemovedAttachIDs?: string;
  @ApiPropertyOptional(ATTACH_FILES_PROPERTY) AttachFiles?: unknown;
}

export class ExpenseRefDto extends EntryChangeDto {
  @ApiProperty({ type: Number }) @Allow() ExpenseUID?: string | number;
}

export class ExpenseStatusDto extends ExpenseRefDto {
  @ApiProperty({ enum: ["Paid", "Cancelled"], description: "Pending → Paid / Cancelled, Paid → Cancelled" }) @Allow() Status?: string;
  @ApiPropertyOptional({ type: Number, description: "Paid: payment type" }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Paid: bank account (empty = cash)" }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional({ description: "Paid: YYYY-MM-DD (default: the expense date)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional() @Allow() PaymentNotes?: string;
}

export class ExpenseBulkDeleteDto extends EntryBulkDeleteDto {
  @ApiPropertyOptional({ type: [Number], description: "ExpenseUIDs (or ExpenseUIDs[]) when not SelectAll" }) @Allow() ExpenseUIDs?: unknown;
}
