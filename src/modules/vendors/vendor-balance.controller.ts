import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { CiValidationError, ciSuccess } from "../../core/response/ci-response";
import { VendorBalanceService, VendorBalanceType } from "../../libraries/vendor-balance/vendor-balance.service";
import { AcceptForm } from "../products/product-files";

export class VendorBalanceQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number, description: "The vendor" }) @Allow() VendorUID?: string | number;
}

export class VendorsForBalanceQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number, description: "One vendor; 0 or empty = every active vendor of the organisation" }) @Allow() VendorUID?: string | number;
}

export class VendorPendingBalanceDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() VendorUID?: string | number;
  @ApiProperty({ type: Number, example: 1250.5, description: "Amount, 0 or more" }) @Allow() PendingBalance?: string | number;
  @ApiProperty({ enum: ["Credit", "Debit"], description: "Credit = we owe the vendor, Debit = the vendor owes us" }) @Allow() PendingBalType?: string;
}

export class VendorLedgerBalanceDto extends OrgUserContextDto {
  @ApiProperty({ type: Number, description: "The vendor's ledger (from getVendorsWithLedgerForBalance)" }) @Allow() LedgerUID?: string | number;
  @ApiProperty({ type: Number, example: 1250.5, description: "Amount, 0 or more" }) @Allow() Balance?: string | number;
  @ApiProperty({ enum: ["Credit", "Debit"] }) @Allow() BalanceType?: string;
}

const vendorOf = (dto: { VendorUID?: string | number }): number => {
  const uid = Number(dto.VendorUID) || 0;
  if (uid <= 0) throw new CiValidationError("VendorUID is required.");
  return uid;
};

const amountOf = (value: unknown, field: string): number => {
  const amount = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(amount) || amount < 0) throw new CiValidationError(`${field} must be an amount of 0 or more.`);
  return amount;
};

const balanceTypeOf = (value: unknown, field: string): VendorBalanceType => {
  if (value !== "Credit" && value !== "Debit") throw new CiValidationError(`${field} must be Credit or Debit.`);
  return value;
};

/**
 * Vendors_model balance functions, one endpoint each, for the CI3 Vendorbalance library.
 * POST api/vendors/recalcBalance does the whole recalculation in one call and is the simpler choice.
 */
@ApiTags("Vendors - Balance")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/vendors")
export class VendorBalanceController {
  constructor(private readonly balance: VendorBalanceService) {}

  @Get("getVendorsWithLedgerForBalance")
  @ApiOperation({ summary: "Opening balance and linked ledger of active vendors: {Data: [{VendorUID, OpeningBalance, OpeningBalType, LedgerUID, LedgerCurrentBalance, LedgerCurrentType}]}" })
  async getVendorsWithLedgerForBalance(@Query() dto: VendorsForBalanceQueryDto) {
    return ciSuccess({ Data: await this.balance.balanceBase(dto.orgId, Number(dto.VendorUID) || 0) });
  }

  @Get("getVendorTotalPurchased")
  @ApiOperation({ summary: "Purchases total, not cancelled / rejected: {Data: number}" })
  async getVendorTotalPurchased(@Query() dto: VendorBalanceQueryDto) {
    return ciSuccess({ Data: await this.balance.totalPurchased(dto.orgId, vendorOf(dto)) });
  }

  @Get("getVendorTotalPaid")
  @ApiOperation({ summary: "Payments to the vendor, not cancelled: {Data: number}" })
  async getVendorTotalPaid(@Query() dto: VendorBalanceQueryDto) {
    return ciSuccess({ Data: await this.balance.totalPaid(dto.orgId, vendorOf(dto)) });
  }

  @Get("getVendorTotalReturned")
  @ApiOperation({ summary: "Purchase returns and debit notes, not cancelled / rejected: {Data: number}" })
  async getVendorTotalReturned(@Query() dto: VendorBalanceQueryDto) {
    return ciSuccess({ Data: await this.balance.totalReturned(dto.orgId, vendorOf(dto)) });
  }

  @Get("getVendorPRCoveredByDebitNote")
  @ApiOperation({ summary: "Purchase returns already turned into a debit note: {Data: number}" })
  async getVendorPRCoveredByDebitNote(@Query() dto: VendorBalanceQueryDto) {
    return ciSuccess({ Data: await this.balance.purchaseReturnsCoveredByDebitNote(dto.orgId, vendorOf(dto)) });
  }

  @Get("getVendorPendingNoteTotals")
  @ApiOperation({ summary: "Pending debit and credit notes: {Data: [pendingDebit, pendingCredit], PendingDebit, PendingCredit}" })
  async getVendorPendingNoteTotals(@Query() dto: VendorBalanceQueryDto) {
    const notes = await this.balance.pendingNoteTotals(dto.orgId, vendorOf(dto));
    return ciSuccess({ Data: [notes.debit, notes.credit], PendingDebit: notes.debit, PendingCredit: notes.credit });
  }

  @Post("updateVendorPendingBalance")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Store the vendor's closing balance in VendOpeningBalanceTbl (insert or update)" })
  async updateVendorPendingBalance(@Body() dto: VendorPendingBalanceDto) {
    const saved = await this.balance.setPendingBalance(
      dto.orgId,
      vendorOf(dto),
      amountOf(dto.PendingBalance, "PendingBalance"),
      balanceTypeOf(dto.PendingBalType, "PendingBalType"),
      dto.userId
    );
    if (!saved) throw new CiValidationError("Vendor not found.");
    return ciSuccess({}, "Vendor pending balance updated.");
  }

  @Post("updateVendorBalanceInLedger")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Store the balance on a vendor's ledger (ChartOfAccounts.CurrentBalance)" })
  async updateVendorBalanceInLedger(@Body() dto: VendorLedgerBalanceDto) {
    const ledgerUID = Number(dto.LedgerUID) || 0;
    if (ledgerUID <= 0) throw new CiValidationError("LedgerUID is required.");
    const saved = await this.balance.setLedgerBalance(
      dto.orgId,
      ledgerUID,
      amountOf(dto.Balance, "Balance"),
      balanceTypeOf(dto.BalanceType, "BalanceType"),
      dto.userId
    );
    if (!saved) throw new CiValidationError("Ledger not found for a vendor of this organisation.");
    return ciSuccess({}, "Ledger balance updated.");
  }
}
