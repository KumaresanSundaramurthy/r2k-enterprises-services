import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { EntryCategoriesService, INCOME_CATEGORIES } from "../expense-income/entry-categories.service";
import { AcceptEntryFiles, recordFiles } from "../expense-income/entry-files";
import { EntryCategoryIdDto, EntryCategoryListDto, EntryCategorySaveDto, EntryListDto, EntryPaymentDto, EntryTransDto } from "../expense-income/entry.dto";
import { AcceptFiles, AcceptForm, FileFields, filesOf } from "../products/product-files";
import { IncomeBulkDeleteDto, IncomeFormDto, IncomeIdDto, IncomeIdQueryDto, IncomeStatusDto } from "./indirect-income.dto";
import { IndirectIncomeService } from "./indirect-income.service";

/**
 * Indirect Income page of CI3 (Indirectincome controller), same method names as its JS calls. List rows are
 * returned as data (CI3 rendered them as HTML). Endpoints the CI3 JS does not call are migrated but hidden from Swagger.
 */
@ApiTags("Indirect Income")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/indirectincome")
export class IndirectIncomeController {
  constructor(
    private readonly income: IndirectIncomeService,
    private readonly categories: EntryCategoriesService
  ) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: Categories, PaymentTypes, BankAccounts, OrgUsers, ShowStats, SummaryStats, RowLimit and the saved date range (InitFilter)" })
  async getPageData(@Query() dto: OrgUserBranchContextDto) {
    return ciSuccess(await this.income.getPageData(dto.orgId, dto.branchId, dto.userId));
  }

  @Get("getPageDetails")
  @ApiOperation({ summary: "Income list page, newest first, PageNo as a query parameter (Data, TotalCount, PageNo, RowLimit, SummaryStats)" })
  async getPageDetailsByQuery(@Query() dto: EntryListDto) {
    return this.getPageDetails(String(dto.PageNo ?? ""), dto);
  }

  @Get("getPageDetails/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Income list page, newest first (Data, TotalCount, PageNo, RowLimit, SummaryStats)" })
  async getPageDetails(@Param("pageNo") pageNo: string, @Query() dto: EntryListDto) {
    return ciSuccess(await this.income.getPage(dto.orgId, dto.branchId, Math.max(1, Number(pageNo) || 1), { ...dto }, dto.Filter ?? {}));
  }

  @Get("getIncomeDetail")
  @ApiOperation({ summary: "One income record with its Attachments (Data)" })
  async getIncomeDetail(@Query() dto: IncomeIdQueryDto) {
    return ciSuccess(await this.income.getDetail(dto.orgId, postInt(dto, "IncomeUID")));
  }

  @Post("addIncome")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Record income (with its receipt when IsReceived = 1); IncomeUID, IncomeNumber and the refreshed first page" })
  async addIncome(@Body() dto: IncomeFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.income.create(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("updateIncome")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update income (not below the amount already received); the journal is re-posted" })
  async updateIncome(@Body() dto: IncomeFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.income.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deleteIncome")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete income (not a cancelled record); returns the refreshed first page" })
  async deleteIncome(@Body() dto: IncomeIdDto, @Req() req: Request) {
    return ciSuccess(await this.income.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteMultipleIncomes")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete several income records, or all matching Filter (SelectAll = 1); others are skipped with a reason" })
  async deleteMultipleIncomes(@Body() dto: IncomeBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.income.deleteBulk(writeContext(dto, req), { ...dto }));
  }

  @Post("updateIncomeStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark income Received (records the receipt) or Cancelled (reverses the journal); returns the refreshed first page" })
  async updateIncomeStatus(@Body() dto: IncomeStatusDto, @Req() req: Request) {
    return ciSuccess(await this.income.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Post("recordPayment")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("PaymentFiles")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Record a full or part receipt (TransUID = IncomeUID); returns the refreshed first page" })
  async recordPayment(@Body() dto: EntryPaymentDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.income.recordPayment(writeContext(dto, req), { ...dto }, filesOf(files, "PaymentFiles")));
  }

  @Get("getPaymentHistory")
  @ApiOperation({ summary: "Receipts of an income record (Payments: Amount, PaymentTypeName, CreatedOn, ReferenceNo)" })
  async getPaymentHistory(@Query() dto: EntryTransDto) {
    return ciSuccess(await this.income.paymentHistory(dto.orgId, postInt(dto, "TransUID")));
  }

  @Get("getPaymentAttachments")
  @ApiOperation({ summary: "Files of an income record's receipts (Attachments, each with its payment's mode, amount and number)" })
  async getPaymentAttachments(@Query() dto: EntryTransDto) {
    return ciSuccess(await this.income.paymentAttachments(dto.orgId, postInt(dto, "TransUID")));
  }

  @Get("getCategoryList")
  @ApiOperation({ summary: "Category manager page, 30 a page (Data with IsSystem, TotalCount, PageNo, RowLimit)" })
  async getCategoryList(@Query() dto: EntryCategoryListDto) {
    return ciSuccess(await this.income.getCategoryList(dto.orgId, { ...dto }));
  }

  @Post("addCategory")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add a category (CategoryUID, CategoryName)" })
  async addCategory(@Body() dto: EntryCategorySaveDto, @Req() req: Request) {
    return ciSuccess(await this.categories.add(INCOME_CATEGORIES, writeContext(dto, req), String(dto.CategoryName ?? ""), null));
  }

  @Post("updateCategory")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Rename one of the organisation's categories (CategoryUID, CategoryName)" })
  async updateCategory(@Body() dto: EntryCategorySaveDto, @Req() req: Request) {
    return ciSuccess(await this.categories.rename(INCOME_CATEGORIES, writeContext(dto, req), postInt(dto, "CategoryUID"), String(dto.CategoryName ?? ""), null));
  }

  @Post("deleteCategory")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a category no live income record uses" })
  async deleteCategory(@Body() dto: EntryCategoryIdDto, @Req() req: Request) {
    return ciSuccess(await this.categories.delete(INCOME_CATEGORIES, writeContext(dto, req), postInt(dto, "CategoryUID"), null));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Get("getCategories")
  @ApiExcludeEndpoint()
  async getCategories(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.income.getCategories(dto.orgId));
  }

  @Post("duplicateIncome")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicateIncome(@Body() dto: IncomeIdDto, @Req() req: Request) {
    return ciSuccess(await this.income.duplicate(writeContext(dto, req), { ...dto }));
  }
}
