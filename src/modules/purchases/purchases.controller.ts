import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { recordFiles } from "../expense-income/entry-files";
import { AcceptForm, FileFields } from "../products/product-files";
import { TransChangeDto, TransPageDataDto } from "../transactions/transaction-form.dto";
import { AcceptDocumentFiles, paymentFiles } from "./purchase-files";
import { PurchasePaymentsService } from "./purchase-payments.service";
import {
  ApplyDebitNoteDto,
  DebitNoteIdDto,
  DebitNotesListDto,
  PurchaseDeleteDto,
  PurchaseFormDto,
  PurchaseFormQueryDto,
  PurchasePaymentDto,
  PurchaseStatusDto,
  PurchaseDocQueryDto,
  VendorIdQueryDto,
  VendorPaymentsListDto,
} from "./purchases.dto";
import { PurchasesService } from "./purchases.service";

/**
 * Purchase Bills page of CI3 (Purchases controller), same method names as its JS calls. The list, print, files and
 * bulk delete are the shared /api/transactions endpoints (module 105). Endpoints the CI3 JS does not call are hidden.
 */
@ApiTags("Purchases")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/purchases")
export class PurchasesController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly payments: PurchasePaymentsService
  ) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers, PaymentTypes, BankAccounts" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.purchases.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description:
      "PrefixData, NextNumberMap, DispatchAddresses, fltStorageData, AdditionalCharges, TaxList, PaymentTypes, BankAccounts; edit (TransUID): PurchData, " +
      "PurchItems, PurchAttachments, PurchSerialsByProd, VendorAddr, TransactionCharges; new from fromPurchaseOrder: POData, POItems.",
  })
  async getFormData(@Query() dto: PurchaseFormQueryDto) {
    return ciSuccess(await this.purchases.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID"), postInt(dto, "fromPurchaseOrder")));
  }

  @Post("addPurchase")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a purchase bill (action = draft saves it unnumbered); a saved bill moves stock and may record PaymentRows. TransUID, Token" })
  async addPurchase(@Body() dto: PurchaseFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.purchases.add(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("updatePurchase")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a purchase bill; stock, serials, ledger and journal follow. Finalising a draft numbers it (TransUID may change). TransUID, Token" })
  async updatePurchase(@Body() dto: PurchaseFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.purchases.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deletePurchase")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a purchase bill (stock reversed; payments refunded or turned into a debit note); returns the list page" })
  async deletePurchase(@Body() dto: PurchaseDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.purchases.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("updatePurchaseStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Receive, mark paid or cancel a bill (NewStatus; DebitNoteAmount with the debit_note action)" })
  async updatePurchaseStatus(@Body() dto: PurchaseStatusDto, @Req() req: Request) {
    return ciSuccess(await this.purchases.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Post("recordPurchasePayment")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Record a payment and / or a debit-note credit against a bill (IsFullyPaid, the list page and SummaryStats)" })
  async recordPurchasePayment(@Body() dto: PurchasePaymentDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.payments.record(writeContext(dto, req), { ...dto }, paymentFiles(files)));
  }

  @Get("getVendorDebitNotes")
  @ApiOperation({ summary: "A vendor's Pending debit notes with a balance (Data)" })
  async getVendorDebitNotes(@Query() dto: VendorIdQueryDto) {
    return ciSuccess(await this.payments.vendorDebitNotes(dto.orgId, postInt(dto, "VendorUID")));
  }

  @Get("getDebitNotesList")
  @ApiOperation({ summary: "Debit Notes tab: vendor debit notes (Data, TotalCount, PageNo, RowLimit)" })
  async getDebitNotesList(@Query() dto: DebitNotesListDto) {
    return ciSuccess(await this.payments.debitNotes(dto.orgId, postInt(dto, "PageNo"), postInt(dto, "RowLimit"), String(dto.Status ?? ""), String(dto.Search ?? "")));
  }

  @Post("refundDebitNote")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark a Pending debit note Refunded (the vendor paid it back)" })
  async refundDebitNote(@Body() dto: DebitNoteIdDto, @Req() req: Request) {
    return ciSuccess(await this.payments.refundDebitNote(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteDebitNote")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a Pending debit note" })
  async deleteDebitNote(@Body() dto: DebitNoteIdDto, @Req() req: Request) {
    return ciSuccess(await this.payments.deleteDebitNote(writeContext(dto, req), { ...dto }));
  }

  @Get(["getPurchasePaymentsPageDetails", "getPurchasePaymentsPageDetails/:pageNo"])
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: "Purchase Payments page: payments made to vendors (Data, TotalCount, PageNo, RowLimit, Totals)" })
  async getPurchasePaymentsPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: VendorPaymentsListDto) {
    return ciSuccess(await this.payments.paymentsPage(dto.orgId, Number(pageNo ?? dto.PageNo) || 1, postInt(dto, "RowLimit") || undefined, dto.Filter ?? {}));
  }

  @Get("getPaymentAttachments")
  @ApiOperation({ summary: "Files of a bill's payments, each with the payment's mode, amount and number (Attachments)" })
  async getPaymentAttachments(@Query() dto: PurchaseDocQueryDto) {
    return ciSuccess(await this.payments.paymentAttachments(dto.orgId, postInt(dto, "TransUID")));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("duplicatePurchase")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicatePurchase(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.purchases.duplicate(writeContext(dto, req), { ...dto }));
  }

  @Post("applyDebitNote")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async applyDebitNote(@Body() dto: ApplyDebitNoteDto, @Req() req: Request) {
    return ciSuccess(await this.payments.applyDebitNote(writeContext(dto, req), { ...dto }));
  }
}
