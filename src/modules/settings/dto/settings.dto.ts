import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgContextDto } from "../../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";

// The CI3 settings forms, field for field (same names the CI3 JS posts). Values are checked in the services
// with CI3's rules and fallbacks, so properties here are only allowed through.

export class GeneralSettingsFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ example: "₹", description: "One character" }) @Allow() CurrenySymbol?: string;
  @ApiPropertyOptional() @Allow() SerialNoDisplay?: string | number;
  @ApiPropertyOptional({ description: "1–12 (default 4)" }) @Allow() FYStartMonth?: string | number;
  @ApiPropertyOptional({ enum: [10, 25, 50, 100] }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ description: "1–15 (default 6)" }) @Allow() QtyMaxLength?: string | number;
  @ApiPropertyOptional() @Allow() EnableStorage?: string | number;
  @ApiPropertyOptional() @Allow() MandatoryStorage?: string | number;
  @ApiPropertyOptional({ description: "1–5 (default 3)" }) @Allow() MaxShippingAddr?: string | number;
  @ApiPropertyOptional({ example: "d-m-Y" }) @Allow() FormDateFormat?: string;
  @ApiPropertyOptional({ example: "d-m-Y" }) @Allow() ListDateFormat?: string;
  @ApiPropertyOptional({ example: "d-m-Y" }) @Allow() PrintDateFormat?: string;
  @ApiPropertyOptional({ example: "d-m-Y H:i" }) @Allow() FormDateTimeFormat?: string;
  @ApiPropertyOptional({ example: "d-m-Y H:i" }) @Allow() ListDateTimeFormat?: string;
  @ApiPropertyOptional({ example: "d-m-Y H:i" }) @Allow() PrintDateTimeFormat?: string;
  @ApiPropertyOptional() @Allow() DefaultSalutationUID?: string | number;
  @ApiPropertyOptional() @Allow() ShowStats?: string | number;
  @ApiPropertyOptional() @Allow() StatsDefaultOpen?: string | number;
  @ApiPropertyOptional() @Allow() EnableAIAssistant?: string | number;
  @ApiPropertyOptional() @Allow() TwoStepLogin?: string | number;
  @ApiPropertyOptional({ example: "EMP" }) @Allow() EmpCodePrefix?: string;
  @ApiPropertyOptional({ enum: ["-", "/", "none"] }) @Allow() EmpCodeSeparator?: string;
  @ApiPropertyOptional({ enum: [3, 4, 5, 6] }) @Allow() EmpCodeDigits?: string | number;
}

export class ProductSettingsFormDto extends OrgUserContextDto {
  @ApiProperty() @Allow() DefaultProductTypeUID?: string | number;
  @ApiProperty() @Allow() DefaultDiscountTypeUID?: string | number;
  @ApiProperty() @Allow() DefaultProductTaxUID?: string | number;
  @ApiProperty() @Allow() DefaultTaxDetailUID?: string | number;
}

export class TransactionSettingsFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ enum: ["ask", "credit_note", "refund", "cancel_only"] }) @Allow() InvoiceCancelAction?: string;
  @ApiPropertyOptional({ enum: ["ask", "debit_note", "refund"] }) @Allow() PurchaseCancelAction?: string;
  @ApiPropertyOptional({ enum: ["ask", "recover", "writeoff"] }) @Allow() SalesReturnCancelAction?: string;
  @ApiPropertyOptional({ enum: ["Manual", "Automatic", "Both"] }) @Allow() SalesReturnItemMethod?: string;
  @ApiPropertyOptional() @Allow() TermsAndConditions?: string;
  @ApiPropertyOptional() @Allow() HideNavOnTransForm?: string | number;
  @ApiPropertyOptional() @Allow() PurchaseShowSignature?: string | number;
  @ApiPropertyOptional() @Allow() PurchaseShowTerms?: string | number;
  @ApiPropertyOptional({ enum: ["ask", "recover", "writeoff"] }) @Allow() PurchaseReturnCancelAction?: string;
  @ApiPropertyOptional({ enum: ["Manual", "Automatic", "Both"] }) @Allow() PurchaseReturnItemMethod?: string;
  @ApiPropertyOptional() @Allow() ShowProductDescription?: string | number;
  @ApiPropertyOptional() @Allow() ShowTransactionStats?: string | number;
  @ApiPropertyOptional({ enum: [0, 3, 5, 7, 10, 14, 21, 30] }) @Allow() DCDefaultReturnDays?: string | number;
  @ApiPropertyOptional({ description: "1–365 (default 7)" }) @Allow() QuotValidityDays?: string | number;
  @ApiPropertyOptional({ enum: ["ratio", "average"] }) @Allow() ComboPriceDistribution?: string;
  @ApiPropertyOptional({ enum: ["warn", "strict"] }) @Allow() BelowPurchasePriceAction?: string;
  @ApiPropertyOptional({ enum: ["regular", "without_tax"] }) @Allow() DefaultTransactionType?: string;
  @ApiPropertyOptional() @Allow() AutoDraftSave?: string | number;
  @ApiPropertyOptional({ enum: ["off", "auto", "manual"] }) @Allow() AutoUpdatePurchasePrice?: string;
}

// ── Bank accounts ───────────────────────────────────────────────────────────

export class BankQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() BankAccountUID?: string | number;
}

export class BankIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() BankAccountUID?: string | number;
}

export class BankFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional({ description: "Required" }) @Allow() AccountName?: string;
  @ApiPropertyOptional({ description: "Required" }) @Allow() AccountNumber?: string;
  @ApiPropertyOptional({ description: "Must match AccountNumber when adding" }) @Allow() ConfirmAccountNumber?: string;
  @ApiPropertyOptional({ description: "Required" }) @Allow() IFSC?: string;
  @ApiPropertyOptional({ description: "Required" }) @Allow() BankName?: string;
  @ApiPropertyOptional({ description: "Required" }) @Allow() BranchName?: string;
  @ApiPropertyOptional() @Allow() UPIId?: string;
  @ApiPropertyOptional() @Allow() UPINumber?: string;
  @ApiPropertyOptional() @Allow() OpeningBalance?: string | number;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ description: "1 = make it the default bank" }) @Allow() IsDefault?: string | number;
}

export class FundTransferDto extends OrgUserContextDto {
  @ApiProperty() @Allow() FromBankUID?: string | number;
  @ApiProperty() @Allow() ToBankUID?: string | number;
  @ApiProperty({ description: "Greater than zero" }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() TransferDate?: string;
  @ApiPropertyOptional() @Allow() ReferenceNo?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
}

// ── Message templates ───────────────────────────────────────────────────────

export class MessageTemplateQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() TemplateUID?: string | number;
}

export class MessageTemplateIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() TemplateUID?: string | number;
}

export class MessageTemplateFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() TemplateUID?: string | number;
  @ApiProperty() @Allow() ModuleUID?: string | number;
  @ApiProperty({ enum: ["Email", "WhatsApp", "SMS"] }) @Allow() Channel?: string;
  @ApiPropertyOptional() @Allow() Subject?: string;
  @ApiProperty({ description: "Text with {{TOKENS}}" }) @Allow() Body?: string;
}

// ── Thermal print ───────────────────────────────────────────────────────────

export class ThermalConfigIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() ThermalConfigUID?: string | number;
}

export class ThermalConfigFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add (one config per module)" }) @Allow() ThermalConfigUID?: string | number;
  @ApiProperty() @Allow() ModuleUID?: string | number;
  @ApiPropertyOptional({ enum: ["58mm", "80mm"] }) @Allow() PaperWidth?: string;
  @ApiPropertyOptional() @Allow() FooterMessage?: string;
  @ApiPropertyOptional() @Allow() ShowTerms?: string | number;
  @ApiPropertyOptional() @Allow() ShowCompanyDetails?: string | number;
  @ApiPropertyOptional() @Allow() ShowItemDescription?: string | number;
  @ApiPropertyOptional() @Allow() ShowTaxableAmount?: string | number;
  @ApiPropertyOptional() @Allow() ShowHSN?: string | number;
  @ApiPropertyOptional() @Allow() ShowTaxBreakdown?: string | number;
  @ApiPropertyOptional() @Allow() ShowGSTIN?: string | number;
  @ApiPropertyOptional() @Allow() ShowMobile?: string | number;
  @ApiPropertyOptional() @Allow() ShowCashReceived?: string | number;
  @ApiPropertyOptional() @Allow() ShowLogo?: string | number;
  @ApiPropertyOptional() @Allow() ShowGoogleReviewQR?: string | number;
  @ApiPropertyOptional() @Allow() ShowPaymentQR?: string | number;
  @ApiPropertyOptional({ description: "8–40 (default 16)" }) @Allow() OrgNameFontSize?: string | number;
  @ApiPropertyOptional({ description: "8–40 (default 14)" }) @Allow() CompanyNameFontSize?: string | number;
  @ApiPropertyOptional({ description: "8–40 (default 12)" }) @Allow() ProductInfoFontSize?: string | number;
}

// ── Prefix config ───────────────────────────────────────────────────────────

export class PrefixIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() prePrefixUID?: string | number;
}

export class PrefixFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() prePrefixUID?: string | number;
  @ApiPropertyOptional({ description: "Required when adding" }) @Allow() preModuleUID?: string | number;
  @ApiProperty({ description: "2–7 letters/digits" }) @Allow() transPrefixName?: string;
  @ApiPropertyOptional({ enum: ["", "-", "/", "|", "_", "."] }) @Allow() prefixSeparator?: string;
  @ApiPropertyOptional({ enum: ["1", "3"] }) @Allow() numberPadding?: string | number;
  @ApiPropertyOptional() @Allow() includeFiscalYear?: string | number;
  @ApiPropertyOptional({ enum: ["SHORT", "LONG"] }) @Allow() fiscalYearFormat?: string;
  @ApiPropertyOptional() @Allow() includeShortName?: string | number;
  @ApiPropertyOptional() @Allow() companyShortName?: string;
  @ApiPropertyOptional({ description: "JSON" }) @Allow() componentConfig?: string;
  @ApiPropertyOptional() @Allow() isDefault?: string | number;
}

// ── Additional charges ──────────────────────────────────────────────────────

export class ChargeIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() acChargeUID?: string | number;
}

export class ChargeFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() acChargeUID?: string | number;
  @ApiPropertyOptional({ description: "Key; built from the display name when empty" }) @Allow() acName?: string;
  @ApiProperty({ description: "Required, max 150 characters" }) @Allow() acDisplayName?: string;
  @ApiPropertyOptional() @Allow() acDescription?: string;
  @ApiPropertyOptional() @Allow() acDefaultTaxUID?: string | number;
  @ApiPropertyOptional() @Allow() acShowByDefault?: string | number;
  @ApiPropertyOptional() @Allow() acSortOrder?: string | number;
}
