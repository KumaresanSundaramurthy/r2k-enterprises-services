import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { ATTACH_FILES_PROPERTY, EntryBulkDeleteDto, EntryChangeDto } from "../expense-income/entry.dto";

// Field names are the CI3 POST names of the income modal; the service reads them as CI3 does (getPostValue).

export class IncomeIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() IncomeUID?: string | number;
}

export class IncomeFormDto extends EntryChangeDto {
  @ApiPropertyOptional({ type: Number, description: "updateIncome only" }) @Allow() IncomeUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() IncomeDate?: string;
  @ApiProperty({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() CategoryUID?: string | number;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number, description: "addIncome: 1 = received now (payment fields required)" }) @Allow() IsReceived?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Empty = the cash account" }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default: the income date)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional() @Allow() PaymentNotes?: string;
  @ApiPropertyOptional({ description: "Edit: JSON array (or comma list) of removed attachment AttachUIDs" }) @Allow() RemovedAttachIDs?: string;
  @ApiPropertyOptional(ATTACH_FILES_PROPERTY) AttachFiles?: unknown;
}

export class IncomeIdDto extends EntryChangeDto {
  @ApiProperty({ type: Number }) @Allow() IncomeUID?: string | number;
}

export class IncomeStatusDto extends IncomeIdDto {
  @ApiProperty({ enum: ["Received", "Cancelled"], description: "Pending → Received / Cancelled, Received → Cancelled" }) @Allow() Status?: string;
  @ApiPropertyOptional({ type: Number, description: "Received: payment type" }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Received: bank account (empty = cash)" }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional({ description: "Received: YYYY-MM-DD (default: the income date)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional() @Allow() PaymentNotes?: string;
}

export class IncomeBulkDeleteDto extends EntryBulkDeleteDto {
  @ApiPropertyOptional({ type: [Number], description: "IncomeUIDs (or IncomeUIDs[]) when not SelectAll" }) @Allow() IncomeUIDs?: unknown;
}
