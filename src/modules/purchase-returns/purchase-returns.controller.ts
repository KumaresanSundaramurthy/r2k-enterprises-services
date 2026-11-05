import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { recordFiles } from "../expense-income/entry-files";
import { AcceptForm, FileFields } from "../products/product-files";
import { AcceptDocumentFiles, paymentFiles } from "../purchases/purchase-files";
import { PurchaseDocQueryDto, VendorDocumentFormDto, VendorIdQueryDto } from "../purchases/purchases.dto";
import { TransChangeDto, TransFormQueryDto, TransPageDataDto } from "../transactions/transaction-form.dto";
import { PurchaseReturnsService } from "./purchase-returns.service";

export class PurchaseReturnFormDto extends VendorDocumentFormDto {
  @ApiPropertyOptional({ description: "YYYY-MM-DD (return date)" }) @Allow() returnDate?: string;
  @ApiPropertyOptional({ type: Number, description: "The bill the lines come from (lines carry sourceTransProdUID)" }) @Allow() fromPurchaseUID?: string | number;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "PaymentFiles[] — files of the first refund row" }) PaymentFiles?: unknown;
}

export class PurchaseReturnStatusDto extends TransChangeDto {
  @ApiProperty({ enum: ["Approved", "Cancelled"], description: "Draft → Approved / Cancelled; Approved, Partial, Paid → Cancelled" }) @Allow() Status?: string;
  @ApiPropertyOptional({ enum: ["recover", "writeoff"], description: "Needed when cancelling a refunded return (else RequiresAction)" }) @Allow() CancelPaymentAction?: string;
}

export class RefundDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() PaymentTypeUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional() @Allow() ReferenceNo?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "PaymentFiles[] (up to 3, 3 MB each)" }) PaymentFiles?: unknown;
}

export class ReturnIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() PurchaseReturnUID?: string | number;
}

export class ApplyDebitDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() PurchaseReturnUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() PurchaseUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional() @Allow() Notes?: string;
}

/**
 * Purchase Returns page of CI3 (Purchasereturns controller), same method names as its JS calls. The list, print, files
 * and bulk delete are the shared /api/transactions endpoints (module 108). Endpoints the CI3 JS does not call are hidden.
 */
@ApiTags("Purchase Returns")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/purchasereturns")
export class PurchaseReturnsController {
  constructor(private readonly returns: PurchaseReturnsService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers, PaymentTypes, BankAccounts" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.returns.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description:
      "PrefixData, NextNumberMap, DispatchAddresses, fltStorageData, AdditionalCharges, TaxList; new: PaymentTypes, BankAccounts; edit (TransUID): " +
      "PRData, PRItems, TransactionCharges, VendorAddr, PRSerialsByProd, PRAttachments.",
  })
  async getFormData(@Query() dto: TransFormQueryDto) {
    return ciSuccess(await this.returns.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID")));
  }

  @Post("addPurchaseReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a purchase return (action = draft saves it unnumbered); a saved return moves stock out, may record refunds and raises a debit note. TransUID, Token" })
  async addPurchaseReturn(@Body() dto: PurchaseReturnFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.returns.add(writeContext(dto, req), { ...dto }, recordFiles(files), paymentFiles(files)));
  }

  @Post("updatePurchaseReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a purchase return; stock and serials follow. Finalising a draft numbers it (TransUID may change). TransUID, Token" })
  async updatePurchaseReturn(@Body() dto: PurchaseReturnFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.returns.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deletePurchaseReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a purchase return (stock reversed); returns the list page" })
  async deletePurchaseReturn(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.returns.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("updatePurchaseReturnStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Approve or cancel a return (NewStatus; RequiresAction + RefundAmount when a refunded return needs recover / writeoff)" })
  async updatePurchaseReturnStatus(@Body() dto: PurchaseReturnStatusDto, @Req() req: Request) {
    return ciSuccess(await this.returns.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Get("getVendorPurchases")
  @ApiOperation({ summary: "A vendor's bills with lines still to return (Purchases)" })
  async getVendorPurchases(@Query() dto: VendorIdQueryDto) {
    return ciSuccess(await this.returns.vendorPurchases(dto.orgId, postInt(dto, "VendorUID")));
  }

  @Get("getPurchaseItems")
  @ApiOperation({ summary: "A bill's lines with ReturnedQty / RemainingQty, fully returned lines left out (Header, Items)" })
  async getPurchaseItems(@Query() dto: PurchaseDocQueryDto) {
    return ciSuccess(await this.returns.purchaseItems(dto.orgId, postInt(dto, "TransUID")));
  }

  @Post("recordPayment")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Record a refund received from the vendor against a return" })
  async recordPayment(@Body() dto: RefundDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.returns.recordRefund(writeContext(dto, req), { ...dto }, paymentFiles(files)));
  }

  @Get("getPendingPurchases")
  @ApiOperation({ summary: "The return's vendor's bills with a balance to pay (Purchases)" })
  async getPendingPurchases(@Query() dto: ReturnIdQueryDto) {
    return ciSuccess(await this.returns.pendingPurchases(dto.orgId, postInt(dto, "PurchaseReturnUID")));
  }

  @Post("applyDebit")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Settle part of one of the vendor's bills with the return's unrefunded value" })
  async applyDebit(@Body() dto: ApplyDebitDto, @Req() req: Request) {
    return ciSuccess(await this.returns.applyDebit(writeContext(dto, req), { ...dto }));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("duplicatePurchaseReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicatePurchaseReturn(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.returns.duplicate(writeContext(dto, req), { ...dto }));
  }

  @Get("getPRCancelDependencies")
  @ApiExcludeEndpoint()
  async getPRCancelDependencies(@Query() dto: PurchaseDocQueryDto) {
    return ciSuccess(await this.returns.cancelDependencies(dto.orgId, postInt(dto, "TransUID")));
  }
}
