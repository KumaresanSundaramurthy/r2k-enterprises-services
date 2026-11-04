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
import { EntryCategoriesService, EXPENSE_CATEGORIES } from "../expense-income/entry-categories.service";
import { AcceptEntryFiles, recordFiles } from "../expense-income/entry-files";
import { EntryCategoryIdDto, EntryCategoryListDto, EntryCategorySaveDto, EntryListDto, EntryPaymentDto, EntryTransDto } from "../expense-income/entry.dto";
import { AcceptFiles, AcceptForm, FileFields, filesOf } from "../products/product-files";
import { ExpenseBulkDeleteDto, ExpenseFormQueryDto, ExpenseIdQueryDto, ExpenseRefDto, ExpenseSaveDto, ExpenseStatusDto } from "./expenses.dto";
import { ExpensesService } from "./expenses.service";

// The category manager's page and search, returned refreshed after a change (CI3 _appendCategoryListResponse)
const categoryQuery = (dto: EntryCategorySaveDto | EntryCategoryIdDto) => ({ pageNo: postInt(dto, "PageNo") || 1, search: String(dto.Search ?? "") });

/**
 * Expenses page of CI3 (Expenses controller), same method names as its JS calls. List rows are returned as
 * data (CI3 rendered them as HTML). Endpoints the CI3 JS does not call are migrated but hidden from Swagger.
 */
@ApiTags("Expenses")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/expenses")
export class ExpensesController {
  constructor(
    private readonly expenses: ExpensesService,
    private readonly categories: EntryCategoriesService
  ) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: Categories, PaymentTypes, BankAccounts, OrgUsers, ShowStats, SummaryStats, RowLimit and the saved date range (InitFilter)" })
  async getPageData(@Query() dto: OrgUserBranchContextDto) {
    return ciSuccess(await this.expenses.getPageData(dto.orgId, dto.branchId, dto.userId));
  }

  @Get("getFormData")
  @ApiOperation({ summary: "Add / edit form data: Categories, PaymentTypes, BankAccounts, ExpenseData, ExpenseItems, ExpenseAttachments, VendorStateCode" })
  async getFormData(@Query() dto: ExpenseFormQueryDto) {
    return ciSuccess(await this.expenses.getFormData(dto.orgId, postInt(dto, "ExpenseUID")));
  }

  @Get("getPageDetails")
  @ApiOperation({ summary: "Expense list page, newest first, PageNo as a query parameter (Data, TotalCount, PageNo, RowLimit, SummaryStats when ShowStats = 1)" })
  async getPageDetailsByQuery(@Query() dto: EntryListDto) {
    return this.getPageDetails(String(dto.PageNo ?? ""), dto);
  }

  @Get("getPageDetails/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Expense list page, newest first (Data, TotalCount, PageNo, RowLimit, SummaryStats when ShowStats = 1)" })
  async getPageDetails(@Param("pageNo") pageNo: string, @Query() dto: EntryListDto) {
    return ciSuccess(await this.expenses.getPage(dto.orgId, dto.branchId, Math.max(1, Number(pageNo) || 1), { ...dto }, dto.Filter ?? {}));
  }

  @Get("getExpenseDetail")
  @ApiOperation({ summary: "One expense (Data) with its line items (Items)" })
  async getExpenseDetail(@Query() dto: ExpenseIdQueryDto) {
    return ciSuccess(await this.expenses.getDetail(dto.orgId, postInt(dto, "ExpenseUID")));
  }

  @Get("getTdsSections")
  @ApiOperation({ summary: "TDS sections for the dropdown (Data)" })
  async getTdsSections() {
    return ciSuccess(await this.expenses.getTdsSections());
  }

  @Post("addExpense")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create an expense (with its payment when IsPaid = 1); ExpenseUID, ExpenseNumber" })
  async addExpense(@Body() dto: ExpenseSaveDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.expenses.create(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("updateExpense")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update an expense (not below the amount already paid); the journal is re-posted" })
  async updateExpense(@Body() dto: ExpenseSaveDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.expenses.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deleteExpense")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete an expense (not a cancelled one); returns the refreshed first page" })
  async deleteExpense(@Body() dto: ExpenseRefDto, @Req() req: Request) {
    return ciSuccess(await this.expenses.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteMultipleExpenses")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete several expenses, or all matching Filter (SelectAll = 1); others are skipped with a reason" })
  async deleteMultipleExpenses(@Body() dto: ExpenseBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.expenses.deleteBulk(writeContext(dto, req), { ...dto }));
  }

  @Post("updateExpenseStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark an expense Paid (records the payment) or Cancelled (reverses the journal); returns the refreshed first page" })
  async updateExpenseStatus(@Body() dto: ExpenseStatusDto, @Req() req: Request) {
    return ciSuccess(await this.expenses.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Post("recordPayment")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("PaymentFiles")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Record a full or part payment (TransUID = ExpenseUID); returns the refreshed first page" })
  async recordPayment(@Body() dto: EntryPaymentDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.expenses.recordPayment(writeContext(dto, req), { ...dto }, filesOf(files, "PaymentFiles")));
  }

  @Get("getPaymentHistory")
  @ApiOperation({ summary: "Payments of an expense (Payments: Amount, PaymentTypeName, CreatedOn, ReferenceNo)" })
  async getPaymentHistory(@Query() dto: EntryTransDto) {
    return ciSuccess(await this.expenses.paymentHistory(dto.orgId, postInt(dto, "TransUID")));
  }

  @Get("getPaymentAttachments")
  @ApiOperation({ summary: "Files of an expense's payments (Attachments, each with its payment's mode, amount and number)" })
  async getPaymentAttachments(@Query() dto: EntryTransDto) {
    return ciSuccess(await this.expenses.paymentAttachments(dto.orgId, postInt(dto, "TransUID")));
  }

  @Get("getCategoryList")
  @ApiOperation({ summary: "Category manager page, 30 a page (Data with IsSystem, TotalCount, PageNo, RowLimit)" })
  async getCategoryList(@Query() dto: EntryCategoryListDto) {
    return ciSuccess(await this.expenses.getCategoryList(dto.orgId, { ...dto }));
  }

  @Post("addCategory")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add a category (CategoryUID, CategoryName, and the manager's page as CatData / CatTotalCount / CatPageNo)" })
  async addCategory(@Body() dto: EntryCategorySaveDto, @Req() req: Request) {
    return ciSuccess(await this.categories.add(EXPENSE_CATEGORIES, writeContext(dto, req), String(dto.CategoryName ?? ""), categoryQuery(dto)));
  }

  @Post("updateCategory")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Rename one of the organisation's categories (and the manager's page)" })
  async updateCategory(@Body() dto: EntryCategorySaveDto, @Req() req: Request) {
    return ciSuccess(
      await this.categories.rename(EXPENSE_CATEGORIES, writeContext(dto, req), postInt(dto, "CategoryUID"), String(dto.CategoryName ?? ""), categoryQuery(dto))
    );
  }

  @Post("deleteCategory")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a category no live expense uses (and the manager's page)" })
  async deleteCategory(@Body() dto: EntryCategoryIdDto, @Req() req: Request) {
    return ciSuccess(await this.categories.delete(EXPENSE_CATEGORIES, writeContext(dto, req), postInt(dto, "CategoryUID"), categoryQuery(dto)));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Get("getCategories")
  @ApiExcludeEndpoint()
  async getCategories(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.expenses.getCategories(dto.orgId));
  }

  @Post("duplicateExpense")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicateExpense(@Body() dto: ExpenseRefDto, @Req() req: Request) {
    return ciSuccess(await this.expenses.duplicate(writeContext(dto, req), { ...dto }));
  }
}
