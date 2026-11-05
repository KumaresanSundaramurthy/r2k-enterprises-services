import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { recordFiles } from "../expense-income/entry-files";
import { AcceptForm, FileFields } from "../products/product-files";
import { AcceptDocumentFiles, paymentFiles } from "../purchases/purchase-files";
import { TransChangeDto, TransPageDataDto } from "../transactions/transaction-form.dto";
import {
  CreditNoteActionDto,
  CreditNotesListDto,
  CustomerIdQueryDto,
  InvoiceDeleteDto,
  InvoiceFormDto,
  InvoiceFormQueryDto,
  InvoicePaymentDto,
  InvoiceStatusDto,
  SalesDocQueryDto,
} from "./invoices.dto";
import { InvoicesService } from "./invoices.service";

/**
 * Invoices page of CI3 (Invoices controller), same method names as its JS calls. The list, print, files and bulk
 * delete are the shared /api/transactions endpoints (module 103). Endpoints the CI3 JS does not call are hidden.
 */
@ApiTags("Invoices")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/invoices")
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers, templates, PaymentTypes, BankAccounts, CreditNotes (creditnotes tab)" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.invoices.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description:
      "PrefixData, NextNumberMap, DispatchAddresses, fltStorageData, AdditionalCharges, TaxList, PaymentTypes, BankAccounts; edit (TransUID or Token): InvData, InvItems, " +
      "ReturnedQtyMap, HasSalesReturns, CustAddr, DraftReservedCN, InvAttachments, TransactionCharges, InvSerialsByProd; new: SalesOrder / Quotation / ProForma / Challan data + items.",
  })
  async getFormData(@Query() dto: InvoiceFormQueryDto) {
    return ciSuccess(
      await this.invoices.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID"), String(dto.Token ?? "").trim(), {
        salesOrder: postInt(dto, "fromSalesOrder"),
        quotation: postInt(dto, "fromQuotation"),
        proForma: postInt(dto, "fromProForma"),
        challan: postInt(dto, "fromChallan"),
      })
    );
  }

  @Post("addInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create an invoice (action = draft saves it unnumbered); a saved invoice moves stock and may be paid by a credit note, PaymentRows or on-account credit. TransUID, Token" })
  async addInvoice(@Body() dto: InvoiceFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.invoices.add(writeContext(dto, req), { ...dto }, recordFiles(files), paymentFiles(files)));
  }

  @Post("updateInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update an invoice; stock, ledger and journal follow. Finalising a draft numbers it (TransUID may change). TransUID, Token" })
  async updateInvoice(@Body() dto: InvoiceFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.invoices.update(writeContext(dto, req), { ...dto }, recordFiles(files), paymentFiles(files)));
  }

  @Post("deleteInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete an invoice (stock reversed; payments deleted, credit_note keeps them as a credit note); returns the list page" })
  async deleteInvoice(@Body() dto: InvoiceDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.invoices.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("updateInvoiceStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Change an invoice's status; cancelling settles payments (CreditNote, NeedsDecision, CustomerBalance)" })
  async updateInvoiceStatus(@Body() dto: InvoiceStatusDto, @Req() req: Request) {
    return ciSuccess(await this.invoices.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Post("recordInvoicePayment")
  @HttpCode(HttpStatus.OK)
  @AcceptDocumentFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Record a cash payment and / or advance and on-account credit against an invoice" })
  async recordInvoicePayment(@Body() dto: InvoicePaymentDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.invoices.recordPayment(writeContext(dto, req), { ...dto }, paymentFiles(files)));
  }

  @Get("getPaymentAttachments")
  @ApiOperation({ summary: "Files of an invoice's payments, each with the payment's mode, amount and number (Attachments)" })
  async getPaymentAttachments(@Query() dto: SalesDocQueryDto) {
    return ciSuccess(await this.invoices.paymentAttachments(dto.orgId, postInt(dto, "TransUID")));
  }

  @Get("getCustomerCreditNotes")
  @ApiOperation({ summary: "A customer's usable credit notes (Data)" })
  async getCustomerCreditNotes(@Query() dto: CustomerIdQueryDto) {
    return ciSuccess(await this.invoices.customerCreditNotes(dto.orgId, postInt(dto, "CustomerUID")));
  }

  @Get("getCreditNotesList")
  @ApiOperation({ summary: "Credit Notes tab (Data, TotalCount, PageNo, RowLimit)" })
  async getCreditNotesList(@Query() dto: CreditNotesListDto) {
    return ciSuccess(await this.invoices.creditNotes(dto.orgId, postInt(dto, "PageNo"), postInt(dto, "RowLimit"), String(dto.Status ?? ""), String(dto.Search ?? "")));
  }

  @Post("cancelCreditNote")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Return a Pending / Applied credit note to Pending, clearing its application (Notes → CancelReason)" })
  async cancelCreditNote(@Body() dto: CreditNoteActionDto, @Req() req: Request) {
    return ciSuccess(await this.invoices.cancelCreditNote(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteCreditNote")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a Pending credit note" })
  async deleteCreditNote(@Body() dto: CreditNoteActionDto, @Req() req: Request) {
    return ciSuccess(await this.invoices.deleteCreditNote(writeContext(dto, req), { ...dto }));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("duplicateInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicateInvoice(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.invoices.duplicate(writeContext(dto, req), { ...dto }));
  }

  @Post("applyCreditNote")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async applyCreditNote(@Body() dto: CreditNoteActionDto, @Req() req: Request) {
    return ciSuccess(await this.invoices.applyCreditNote(writeContext(dto, req), { ...dto }));
  }

  @Post("refundCreditNote")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async refundCreditNote(@Body() dto: CreditNoteActionDto, @Req() req: Request) {
    return ciSuccess(await this.invoices.refundCreditNote(writeContext(dto, req), { ...dto }));
  }
}
