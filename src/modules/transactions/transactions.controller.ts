import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { CiValidationError, ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { PackingListsRepository } from "../packing-lists/packing-lists.repository";
import { AcceptForm } from "../products/product-files";
import { TransactionEngineService } from "./transaction-engine.service";
import { kindOf } from "./transaction-kinds";
import { TransactionLookupsRepository } from "./transaction-lookups.repository";
import { TransactionPrefixesService } from "./transaction-prefixes.service";
import { TransactionPrintService } from "./transaction-print.service";
import { TransactionSearchService } from "./transaction-search.service";
import {
  CustomerSearchDto,
  PrefixSaveDto,
  ProductSearchDto,
  TransAttachmentsDto,
  TransBulkDeleteDto,
  TransDetailDto,
  TransListDto,
} from "./transactions.dto";

// CI3 Packinglists $pageModuleUID
const PACKING_LIST_MODULE = 119;

// Expense / indirect-income records keep their files in ExpenseIncomeAttachmentsTbl
const ENTRY_SOURCES: Record<number, string> = { 114: "Expense", 115: "IndirectIncome" };

const pageOf = (pathPage: string | undefined, dto: { PageNo?: string | number }) => Math.max(1, Number(pathPage ?? dto.PageNo) || 1);

// A migrated document type (quotations, sales orders, purchase orders, purchases and purchase returns so far)
function migratedKind(moduleUID: string | number) {
  const kind = kindOf(Number(moduleUID) || 0);
  if (!kind) throw new CiValidationError("Unknown module.");
  return kind;
}

/**
 * The shared /transactions endpoints of CI3 (Transactions controller) the transaction pages call: list, print /
 * detail, files, bulk delete, the customer and product pickers and the prefix modal.
 */
@ApiTags("Transactions")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/transactions")
export class TransactionsController {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly print: TransactionPrintService,
    private readonly search: TransactionSearchService,
    private readonly prefixes: TransactionPrefixesService,
    private readonly lookups: TransactionLookupsRepository,
    private readonly audit: AuditLogService,
    private readonly orgSettings: OrgSettingsService,
    private readonly packingLists: PackingListsRepository
  ) {}

  @Get(["getPageDetails/:moduleUID", "getPageDetails/:moduleUID/:pageNo"])
  @ApiParam({ name: "moduleUID", description: "101 Quotation, 102 Sales Order, 103 Invoice, 104 Purchase Order, 105 Purchase, 106 Sales Return, 108 Purchase Return, 112 Delivery Challan, 113 Pro Forma, 119 Packing List" })
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: "A document list page (Data, TotalCount, PageNo, RowLimit, WhatsAppTemplate, SummaryStats when shown)" })
  async getPageDetails(@Param("moduleUID") moduleUID: string, @Param("pageNo") pageNo: string | undefined, @Query() dto: TransListDto) {
    // Packing lists live in their own table (Transaction.PackingListTbl), not in TransactionsTbl
    if (Number(moduleUID) === PACKING_LIST_MODULE) {
      const page = pageOf(pageNo, dto);
      const limit = await this.orgSettings.resolveRowLimit(dto.orgId, dto.RowLimit);
      const [rows, total] = await Promise.all([this.packingLists.page(dto.orgId, limit, (page - 1) * limit), this.packingLists.count(dto.orgId)]);
      return ciSuccess({ Data: rows, TotalCount: total, PageNo: page, RowLimit: limit });
    }
    return ciSuccess(await this.engine.listPage(migratedKind(moduleUID), dto.orgId, dto.branchId, pageOf(pageNo, dto), dto.RowLimit, dto.Filter ?? {}, dto.langCode));
  }

  @Get("getTransactionDetail")
  @ApiOperation({
    summary: "A document for print or view",
    description: "PrintType a4: Header, PrintHtml. thermal: Header, Items, OrgInfo, ThermalConfig. view: Header, Items, Payments, PaidTotal, Attachments, OrgInfo, Permissions.",
  })
  async getTransactionDetail(@Query() dto: TransDetailDto) {
    return ciSuccess(await this.print.detail(dto.orgId, postInt(dto, "TransUID"), postInt(dto, "ModuleUID"), String(dto.PrintType || "a4")));
  }

  @Get("getAttachments")
  @ApiOperation({ summary: "Files of a document, expense (ModuleUID 114) or indirect income (115) record (Attachments)" })
  async getAttachments(@Query() dto: TransAttachmentsDto) {
    const transUID = postInt(dto, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Invalid record.");
    const source = ENTRY_SOURCES[postInt(dto, "ModuleUID")];
    return ciSuccess({ Attachments: source ? await this.lookups.entryAttachments(dto.orgId, source, transUID) : await this.engine.attachmentsOf(dto.orgId, transUID) });
  }

  @Post("deleteMultipleTransactions/:moduleUID")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiParam({ name: "moduleUID", description: "101 Quotation, 102 Sales Order, 104 Purchase Order, 105 Purchase, 108 Purchase Return" })
  @ApiOperation({ summary: "Delete several documents, or all matching Filter (SelectAll = 1); others are skipped with a reason. Purchases / returns reverse their stock." })
  async deleteMultipleTransactions(@Param("moduleUID") moduleUID: string, @Body() dto: TransBulkDeleteDto, @Req() req: Request) {
    const ctx = writeContext(dto, req);
    const { deleted, errors } = await this.engine.deleteMany(migratedKind(moduleUID), ctx, { ...dto });
    await this.audit.log(ctx, {
      action: "BULK_DELETE_TRANSACTION",
      entityType: "Transaction",
      entityUID: Number(moduleUID),
      entityRef: "",
      summary: `Bulk deleted ${deleted} transaction(s) for module ${moduleUID}`,
      module: "Transactions",
      category: "TRANSACTION",
    });
    return ciSuccess({ Message: `${deleted} record(s) deleted.` + (errors.length > 0 ? ` Skipped: ${errors.join("; ")}` : "") });
  }

  @Get("searchCustomers")
  @ApiOperation({ summary: "Customer picker: 10 customers with balance and address (Lists)" })
  async searchCustomers(@Query() dto: CustomerSearchDto) {
    return ciSuccess(await this.search.customers(dto.orgId, String(dto.term ?? ""), dto.langCode));
  }

  @Get("searchVendors")
  @ApiOperation({ summary: "Vendor picker: 20 vendors with closing balance (Lists)" })
  async searchVendors(@Query() dto: CustomerSearchDto) {
    return ciSuccess(await this.search.vendorList(dto.orgId, String(dto.term ?? ""), dto.langCode));
  }

  @Get("searchTransProducts")
  @ApiOperation({ summary: "Product picker: 30 products with price before tax, stock and tax rates (Lists)" })
  async searchTransProducts(@Query() dto: ProductSearchDto) {
    return ciSuccess(await this.search.products(dto.orgId, String(dto.term ?? ""), postInt(dto, "categuid"), dto.langCode));
  }

  @Get("getTransactionPrefixes")
  @ApiOperation({ summary: "Every prefix of the organisation (Data)" })
  async getTransactionPrefixes(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.prefixes.list(dto.orgId));
  }

  @Post("addTransactionPrefix")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add a prefix for a module (PrefixUID, PrefixData)" })
  async addTransactionPrefix(@Body() dto: PrefixSaveDto, @Req() req: Request) {
    return ciSuccess(await this.prefixes.add(writeContext(dto, req), { ...dto }));
  }

  @Post("updateTransactionPrefix")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Update a prefix (prePrefixUID)" })
  async updateTransactionPrefix(@Body() dto: PrefixSaveDto, @Req() req: Request) {
    return ciSuccess(await this.prefixes.update(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteTransactionPrefix")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a prefix (prePrefixUID)" })
  async deleteTransactionPrefix(@Body() dto: PrefixSaveDto, @Req() req: Request) {
    return ciSuccess(await this.prefixes.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("setDefaultTransactionPrefix")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Make a prefix its module's default (PrefixUID, AllPrefixData)" })
  async setDefaultTransactionPrefix(@Body() dto: PrefixSaveDto, @Req() req: Request) {
    return ciSuccess(await this.prefixes.setDefault(writeContext(dto, req), { ...dto }));
  }
}
