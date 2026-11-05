import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptEntryFiles, recordFiles } from "../expense-income/entry-files";
import { AcceptForm, FileFields } from "../products/product-files";
import { TransChangeDto, TransFormDto, TransFormQueryDto, TransPageDataDto } from "../transactions/transaction-form.dto";
import { SalesOrdersService } from "./sales-orders.service";

export class SalesOrderFormDto extends TransFormDto {
  @ApiPropertyOptional({ description: "Document type" }) @Allow() orderType?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (expected delivery)" }) @Allow() deliveryDate?: string;
  @ApiPropertyOptional({ type: Number, description: "addSalesOrder: the quotation it was made from (marked Converted when not a draft)" }) @Allow() fromQuotationUID?: string | number;
}

export class SalesOrderFormQueryDto extends TransFormQueryDto {
  @ApiPropertyOptional({ type: Number, description: "New form pre-filled from this quotation" }) @Allow() fromQuotation?: string | number;
}

export class SalesOrderStatusDto extends TransChangeDto {
  @ApiProperty({ enum: ["Pending", "Cancelled"], description: "Draft → Pending; Pending → Cancelled" })
  @Allow()
  Status?: string;
}

/**
 * Sales Orders page of CI3 (Salesorders controller), same method names as its JS calls. The list, print, files and
 * bulk delete are the shared /api/transactions endpoints (module 102). Endpoints the CI3 JS does not call are hidden.
 */
@ApiTags("Sales Orders")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/salesorders")
export class SalesOrdersController {
  constructor(private readonly orders: SalesOrdersService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers, message templates, CommOrgContext" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.orders.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description:
      "PrefixData, NextNumberMap, dispatch address(es), fltStorageData, AdditionalCharges, TaxList; edit (TransUID): SOData, SOItems, CustAddr, " +
      "SOAttachments, TransactionCharges; new from fromQuotation: QuotationData, QuotationItems, QuotationAttachments.",
  })
  async getFormData(@Query() dto: SalesOrderFormQueryDto) {
    return ciSuccess(await this.orders.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID"), postInt(dto, "fromQuotation")));
  }

  @Post("addSalesOrder")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a sales order (action = draft saves it unnumbered); TransUID, Token" })
  async addSalesOrder(@Body() dto: SalesOrderFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.orders.add(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("updateSalesOrder")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a sales order; finalising a draft numbers it (TransUID may change). TransUID, Token" })
  async updateSalesOrder(@Body() dto: SalesOrderFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.orders.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deleteSalesOrder")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a sales order; returns the list page (Data, TotalCount, PageNo, RowLimit)" })
  async deleteSalesOrder(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.orders.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("convertSalesOrderToInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark a Pending order Converted and continue on the invoice form (RedirectURL)" })
  async convertSalesOrderToInvoice(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.orders.convert(writeContext(dto, req), { ...dto }, "Invoice"));
  }

  @Post("convertSalesOrderToDeliveryChallan")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark a Pending order Converted and continue on the delivery challan form (RedirectURL)" })
  async convertSalesOrderToDeliveryChallan(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.orders.convert(writeContext(dto, req), { ...dto }, "DeliveryChallan"));
  }

  @Post("updateSalesOrderStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Send a draft or cancel an order (NewStatus and the list page)" })
  async updateSalesOrderStatus(@Body() dto: SalesOrderStatusDto, @Req() req: Request) {
    return ciSuccess(await this.orders.updateStatus(writeContext(dto, req), { ...dto }));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("duplicateSalesOrder")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicateSalesOrder(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.orders.duplicate(writeContext(dto, req), { ...dto }));
  }
}
