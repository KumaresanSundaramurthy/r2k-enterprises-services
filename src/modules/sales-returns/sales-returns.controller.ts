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
import { SalesDocQueryDto, SalesPaidFormDto } from "../invoices/invoices.dto";
import { AcceptForm, FileFields } from "../products/product-files";
import { AcceptDocumentFiles, paymentFiles } from "../purchases/purchase-files";
import { TransChangeDto, TransFormQueryDto, TransPageDataDto } from "../transactions/transaction-form.dto";
import { SalesReturnsService } from "./sales-returns.service";

export class SalesReturnFormDto extends SalesPaidFormDto {
  @ApiPropertyOptional({ description: "Document type" }) @Allow() returnType?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (return date)" }) @Allow() returnDate?: string;
  @ApiPropertyOptional({ description: "addSalesReturn: JSON array of the source invoices' TransUIDs (lines carry sourceTransProdUID)" }) @Allow() fromInvoiceUIDs?: string;
}

export class SalesReturnStatusDto extends TransChangeDto {
  @ApiProperty({ enum: ["Approved", "Cancelled"] }) @Allow() Status?: string;
  @ApiPropertyOptional({ enum: ["recover", "writeoff"], description: "Needed when cancelling a refunded return (else RequiresAction)" }) @Allow() CancelPaymentAction?: string;
}

export class SalesRefundDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() TransUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() PaymentTypeUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional() @Allow() ReferenceNo?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "PaymentFiles[] (up to 3, 3 MB each)" }) PaymentFiles?: unknown;
}

export class SalesReturnItemsQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number, description: "The invoice" }) @Allow() TransUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "The return being edited (its own lines are not counted as returned)" }) @Allow() ExcludeSrUID?: string | number;
}

export class CustomerInvoicesQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() CustomerUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "The return being edited" }) @Allow() ExcludeSrUID?: string | number;
}

export class SalesReturnIdQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() SalesReturnUID?: string | number;
}

export class ApplyCreditDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number }) @Allow() SalesReturnUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() InvoiceUID?: string | number;
  @ApiProperty({ type: Number }) @Allow() Amount?: string | number;
  @ApiPropertyOptional() @Allow() Notes?: string;
}

/**
 * Sales Returns page of CI3 (Salesreturns controller), same method names as its JS calls. The list, print, files and
 * bulk delete are the shared /api/transactions endpoints (module 106). Endpoints the CI3 JS does not call are hidden.
 */
@ApiTags("Sales Returns")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/salesreturns")
export class SalesReturnsController {
  constructor(private readonly returns: SalesReturnsService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers, PaymentTypes, BankAccounts" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.returns.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description: "PrefixData, NextNumberMap, DispatchAddresses, fltStorageData, AdditionalCharges, TaxList; new: PaymentTypes, BankAccounts; edit (TransUID): SRData, SRItems, TransactionCharges, SRSerialsByProd, SRAttachments.",
  })
  async getFormData(@Query() dto: TransFormQueryDto) {
    return ciSuccess(await this.returns.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID")));
  }

  @Post("addSalesReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a sales return (action = draft saves it unnumbered); a saved return moves stock in, may record refunds and raises a credit note. TransUID, Token" })
  async addSalesReturn(@Body() dto: SalesReturnFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.returns.add(writeContext(dto, req), { ...dto }, recordFiles(files), paymentFiles(files)));
  }

  @Post("updateSalesReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a sales return; stock, serials and invoice links follow. Finalising a draft numbers it (TransUID may change). TransUID, Token" })
  async updateSalesReturn(@Body() dto: SalesReturnFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.returns.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deleteSalesReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a sales return (stock reversed, payments and its credit note removed); returns the list page" })
  async deleteSalesReturn(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.returns.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("updateSalesReturnStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Approve or cancel a return (NewStatus, CustomerBalance; RequiresAction + RefundAmount when a refunded return needs recover / writeoff)" })
  async updateSalesReturnStatus(@Body() dto: SalesReturnStatusDto, @Req() req: Request) {
    return ciSuccess(await this.returns.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Get("getInvoiceItems")
  @ApiOperation({ summary: "An invoice's lines with ReturnedQty / RemainingQty, fully returned lines left out (Header, Items)" })
  async getInvoiceItems(@Query() dto: SalesReturnItemsQueryDto) {
    return ciSuccess(await this.returns.invoiceItems(dto.orgId, postInt(dto, "TransUID"), postInt(dto, "ExcludeSrUID")));
  }

  @Get("getCustomerInvoices")
  @ApiOperation({ summary: "A customer's invoices with lines still to return (Invoices)" })
  async getCustomerInvoices(@Query() dto: CustomerInvoicesQueryDto) {
    return ciSuccess(await this.returns.customerInvoices(dto.orgId, postInt(dto, "CustomerUID"), postInt(dto, "ExcludeSrUID")));
  }

  @Get("getPaymentAttachments")
  @ApiOperation({ summary: "Files of a return's payments, each with the payment's mode, amount and number (Attachments)" })
  async getPaymentAttachments(@Query() dto: SalesDocQueryDto) {
    return ciSuccess(await this.returns.paymentAttachments(dto.orgId, postInt(dto, "TransUID")));
  }

  @Post("recordPayment")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Record a refund paid to the customer against a return (CustomerBalance)" })
  async recordPayment(@Body() dto: SalesRefundDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.returns.recordRefund(writeContext(dto, req), { ...dto }, paymentFiles(files)));
  }

  @Get("getPendingInvoices")
  @ApiOperation({ summary: "The return's customer's invoices with a balance to receive (Invoices)" })
  async getPendingInvoices(@Query() dto: SalesReturnIdQueryDto) {
    return ciSuccess(await this.returns.pendingInvoices(dto.orgId, postInt(dto, "SalesReturnUID")));
  }

  @Post("applyCredit")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Settle part of one of the customer's invoices with the return's unrefunded value" })
  async applyCredit(@Body() dto: ApplyCreditDto, @Req() req: Request) {
    return ciSuccess(await this.returns.applyCredit(writeContext(dto, req), { ...dto }));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("duplicateSalesReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicateSalesReturn(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.returns.duplicate(writeContext(dto, req), { ...dto }));
  }

  @Get("getSRCancelDependencies")
  @ApiExcludeEndpoint()
  async getSRCancelDependencies(@Query() dto: SalesDocQueryDto) {
    return ciSuccess(await this.returns.cancelDependencies(dto.orgId, postInt(dto, "TransUID")));
  }
}
