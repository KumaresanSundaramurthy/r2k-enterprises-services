import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, StreamableFile, UploadedFiles, UseFilters, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { writeContext } from "../../core/request/write-context";
import { CustomerFormDto } from "./dto/customer-form.dto";
import {
  ApplyOnAccountDto,
  CustomerAttachmentDeleteDto,
  CustomerAttachmentsDto,
  BillingAddressDto,
  CustomerBulkDeleteDto,
  CustomerIdDto,
  CustomerNoteDto,
  CustomerOpeningBalanceSaveDto,
  CustomerStatusDto,
  CustomerUpdateDto,
} from "./dto/customer-write.dto";
import { CustomerAccountService } from "./customer-account.service";
import { CustomerAttachmentService } from "./customer-attachment.service";
import { CustomerCacheService } from "./customer-cache.service";
import { CustomerExportService } from "./customer-export.service";
import { CustomerProfileService } from "./customer-profile.service";
import { CustomerWriteService } from "./customer-write.service";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { CustomerExportDto, CustomerListDto, CustomerSearchListDto, SearchCustomersDto } from "./dto/customer-list.dto";
import { CustomerBalanceDto, CustomerOpeningBalanceDto, CustomerStatementDto } from "./dto/customer-balance.dto";
import { CustomersService } from "./customers.service";

// Customer images arrive as CustAttachFiles[] (the CI3 FormData name) or CustAttachFiles
const AttachFiles = () =>
  UseInterceptors(
    FileFieldsInterceptor([
      { name: "CustAttachFiles[]", maxCount: 10 },
      { name: "CustAttachFiles", maxCount: 10 },
    ])
  );
type AttachFileFields = Record<string, Express.Multer.File[]> | undefined;
const attachedFiles = (files: AttachFileFields) => [...(files?.["CustAttachFiles[]"] ?? []), ...(files?.CustAttachFiles ?? [])];

// Routes keep CI3's method names so each JS call maps one-to-one to its old /customers/... URL.
@ApiTags("Customers")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/customers")
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly customerWrite: CustomerWriteService,
    private readonly customerAccount: CustomerAccountService,
    private readonly customerProfile: CustomerProfileService,
    private readonly customerCache: CustomerCacheService,
    private readonly customerExport: CustomerExportService,
    private readonly customerAttachments: CustomerAttachmentService
  ) {}

  @Get("getCustomersPageDetails/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Customer list page (Data, TotalCount, PageNo, RowLimit)" })
  // Argument order sets the Swagger parameter order: orgId, pageNo, RowLimit, Filter, langCode
  async getCustomersPageDetails(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: CustomerListDto) {
    return ciSuccess(await this.customersService.getPage(org.orgId, Number(pageNo) || 1, dto));
  }

  @Get("searchCustomers")
  @ApiOperation({ summary: "Typeahead for dropdowns (Lists: [{ id, text }], max 10)" })
  async searchCustomers(@Query() dto: SearchCustomersDto) {
    return ciSuccess(await this.customersService.searchForDropdown(dto));
  }

  @Post("getCustomerSearchList")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Customer picker with closing balance and shipping address" })
  async getCustomerSearchList(@Body() dto: CustomerSearchListDto) {
    return ciSuccess(await this.customersService.searchWithBalance(dto));
  }

  @Get("getCustomerForModal/:uid")
  @ApiOperation({ summary: "One customer with bank details, addresses and attachments" })
  async getCustomerForModal(@Param("uid") uid: string, @Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.customersService.getDetail(dto.orgId, Number(uid), dto.langCode));
  }

  @Get("getCustomerTags")
  @ApiOperation({ summary: "Distinct tags used by the organisation's active customers" })
  async getCustomerTags(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.customersService.getTags(dto.orgId));
  }

  @Get("getCustomerStats")
  @ApiOperation({ summary: "List page counters: totals, this month / FY, to collect, to pay" })
  async getCustomerStats(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.customersService.getStats(dto.orgId));
  }

  @Get("getCustomerTypes")
  @ApiOperation({ summary: "Customer types (global list)" })
  async getCustomerTypes() {
    return ciSuccess(await this.customersService.getTypes());
  }

  @Get("getCustomerOpeningBalance")
  @ApiOperation({ summary: "Opening / closing balance row and the opening snapshot of a financial year" })
  async getCustomerOpeningBalance(@Query() dto: CustomerOpeningBalanceDto) {
    return ciSuccess(await this.customersService.getOpeningBalance(dto));
  }

  @Get("getCustomerBalance")
  @ApiOperation({ summary: "Live balance: opening + invoiced − received − returned, with breakdown" })
  async getCustomerBalance(@Query() dto: CustomerBalanceDto) {
    return ciSuccess(await this.customersService.getBalance(dto));
  }

  @Post("getCustomerOnAccountBalance")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Unapplied (on-account) payments of a customer and their total" })
  async getCustomerOnAccountBalance(@Body() dto: CustomerBalanceDto) {
    return ciSuccess(await this.customersService.getOnAccountBalance(dto));
  }

  @Post("addCustomerData")
  @HttpCode(HttpStatus.OK)
  @AttachFiles()
  @ApiConsumes("application/json", "multipart/form-data")
  @ApiOperation({
    summary: "Create a customer (with addresses, bank details, ledger and opening balance)",
    description:
      "Validation errors return { Error: true, Message, FieldErrors: { field: message } }. On success: Message, " +
      "Customer ({ id, text, address? }) and, with returnList = 1, List / TotalCount / Stats.",
  })
  async addCustomerData(@Body() dto: CustomerFormDto, @UploadedFiles() files: AttachFileFields, @Req() req: Request) {
    return ciSuccess(await this.customerWrite.create(dto, writeContext(dto, req), attachedFiles(files)));
  }

  @Post("updateCustomerData")
  @HttpCode(HttpStatus.OK)
  @AttachFiles()
  @ApiConsumes("application/json", "multipart/form-data")
  @ApiOperation({
    summary: "Update a customer (same fields as create, plus CustomerUID and bank/address deletions)",
    description: "Validation errors return FieldErrors like create. On success: Message and Customer.",
  })
  async updateCustomerData(@Body() dto: CustomerUpdateDto, @UploadedFiles() files: AttachFileFields, @Req() req: Request) {
    return ciSuccess(await this.customerWrite.update(dto, writeContext(dto, req), attachedFiles(files)));
  }

  @Post("deleteCustomerData")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft-delete a customer and deactivate its ledger (refused if it has transactions)" })
  async deleteCustomerData(@Body() dto: CustomerIdDto, @Req() req: Request) {
    return ciSuccess(await this.customerWrite.delete(dto, writeContext(dto, req)));
  }

  @Post("deleteBulkCustomers")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft-delete several customers, or all matching a filter (SelectAll = 1); all or nothing" })
  async deleteBulkCustomers(@Body() dto: CustomerBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.customerWrite.deleteBulk(dto, writeContext(dto, req)));
  }

  @Post("toggleCustomerStatus")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Activate (IsActive = 1) or deactivate (0) a customer" })
  async toggleCustomerStatus(@Body() dto: CustomerStatusDto, @Req() req: Request) {
    return ciSuccess(await this.customerWrite.setStatus(dto, writeContext(dto, req)));
  }

  @Post("saveCustomerOpeningBalance")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Set a customer's opening balance and the financial-year snapshot" })
  async saveCustomerOpeningBalance(@Body() dto: CustomerOpeningBalanceSaveDto, @Req() req: Request) {
    return ciSuccess(await this.customerAccount.saveOpeningBalance(dto, writeContext(dto, req)));
  }

  @Post("updateCustomerBalance")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Store the live balance (opening + invoiced − received − returned); CustomerUID 0 = all" })
  async updateCustomerBalance(@Body() dto: CustomerIdDto, @Req() req: Request) {
    return ciSuccess(await this.customerAccount.updateStoredBalances(dto, writeContext(dto, req)));
  }

  @Post("recalcBalance")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Full closing-balance recalculation incl. credit / debit notes; CustomerUID 0 = all" })
  async recalcBalance(@Body() dto: CustomerIdDto, @Req() req: Request) {
    return ciSuccess(await this.customerAccount.recalculate(dto, writeContext(dto, req)));
  }

  @Post("applyOnAccountPayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Apply an on-account payment to an invoice and recalculate the customer balance" })
  async applyOnAccountPayment(@Body() dto: ApplyOnAccountDto, @Req() req: Request) {
    return ciSuccess(await this.customerAccount.applyOnAccountPayment(dto, writeContext(dto, req)));
  }

  @Post("saveCustomerNote")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add a note to a customer" })
  async saveCustomerNote(@Body() dto: CustomerNoteDto, @Req() req: Request) {
    return ciSuccess(await this.customerWrite.addNote(dto, writeContext(dto, req)));
  }

  @Post("updateBillingAddress")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update (or add) a customer's billing address" })
  async updateBillingAddress(@Body() dto: BillingAddressDto, @Req() req: Request) {
    return ciSuccess(await this.customerWrite.updateBillingAddress(dto, writeContext(dto, req)));
  }

  @Post("exportCustomers")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Export the filtered customer list",
    description:
      "CSV / Excel: the file itself (Content-Disposition: attachment; Customer_Data.csv / .xlsx) — fetch it as a blob. " +
      "Pdf / Print: { Error: false, HtmlData } — an A4 landscape page for the browser print dialog.",
  })
  async exportCustomers(@Body() dto: CustomerExportDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.customerExport.export(dto);
    if (result.kind === "html") return ciSuccess({ HtmlData: result.html });
    res.set({
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Access-Control-Expose-Headers": "Content-Disposition",
      Pragma: "no-cache",
    });
    return new StreamableFile(result.body);
  }

  @Post("syncCustomersCache")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rebuild the Upstash customers cache from every active customer (Message, Count)" })
  async syncCustomersCache(@Body() dto: OrgContextDto) {
    return ciSuccess(await this.customerCache.syncAll(dto.orgId));
  }

  @Get("getCustomerProfileTab/:uid/:tab")
  @ApiParam({ name: "tab", enum: ["overview", "transactions", "statement", "notes"] })
  @ApiOperation({ summary: "Customer profile tab as data (Tab, Data) — CI3 returned it as HTML" })
  async getCustomerProfileTab(@Param("uid") uid: string, @Param("tab") tab: string, @Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.customerProfile.getTab(dto.orgId, Number(uid), tab, dto.langCode));
  }

  @Post("getCustomerStatementTab")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Customer statement for a date range (invoices, receipts, returns) with org header" })
  async getCustomerStatementTab(@Body() dto: CustomerStatementDto) {
    return ciSuccess(
      await this.customerProfile.getStatement(dto.orgId, Number(dto.CustomerUID ?? 0), dto.FromDate, dto.ToDate, dto.langCode)
    );
  }

  @Get("getCustomerAttachments")
  @ApiOperation({ summary: "A customer's images (Attachments: AttachUID, FileName, FilePath, FileSize, SortOrder, CreatedOn, Url)" })
  async getCustomerAttachments(@Query() dto: CustomerAttachmentsDto) {
    return ciSuccess(await this.customerAttachments.list(dto.orgId, Number(dto.CustomerUID) || 0));
  }

  @Post("saveCustomerAttachments")
  @HttpCode(HttpStatus.OK)
  @AttachFiles()
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Upload images (CustAttachFiles[]) for a customer: max 3 images, 3 MB in total (Message, Saved)" })
  async saveCustomerAttachments(@Body() dto: CustomerIdDto, @UploadedFiles() files: AttachFileFields, @Req() req: Request) {
    return ciSuccess(await this.customerAttachments.save(writeContext(dto, req), Number(dto.CustomerUID) || 0, attachedFiles(files)));
  }

  @Post("deleteCustomerAttachment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete one customer image; the next image becomes the customer's primary image" })
  async deleteCustomerAttachment(@Body() dto: CustomerAttachmentDeleteDto, @Req() req: Request) {
    return ciSuccess(
      await this.customerAttachments.deleteOne(writeContext(dto, req), Number(dto.AttachUID) || 0, Number(dto.CustomerUID) || 0)
    );
  }

  @Get("getNextCustomerNumber")
  @ApiOperation({ summary: "Next customer number for the new-customer form" })
  async getNextCustomerNumber(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.customersService.getNextNumber(dto.orgId));
  }
}
