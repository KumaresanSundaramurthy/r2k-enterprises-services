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
import { TransChangeDto, TransFormQueryDto, TransPageDataDto, VendorTransFormDto } from "../transactions/transaction-form.dto";
import { PurchaseOrdersService } from "./purchase-orders.service";

export class PurchaseOrderFormDto extends VendorTransFormDto {
  @ApiPropertyOptional({ description: "Document type" }) @Allow() poType?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (expected delivery)" }) @Allow() expectedDate?: string;
}

export class PurchaseOrderStatusDto extends TransChangeDto {
  @ApiProperty({ enum: ["Received", "Closed", "Cancelled"], description: "Draft → Received; Received → Closed / Cancelled" })
  @Allow()
  Status?: string;
}

/**
 * Purchase Orders page of CI3 (Purchaseorders controller), same method names as its JS calls. The list, print, files
 * and bulk delete are the shared /api/transactions endpoints (module 104). Endpoints the CI3 JS does not call are hidden.
 */
@ApiTags("Purchase Orders")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/purchaseorders")
export class PurchaseOrdersController {
  constructor(private readonly orders: PurchaseOrdersService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.orders.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description: "PrefixData, NextNumberMap, AdditionalCharges, TaxList; edit (TransUID): POData, POItems, VendorAddr, TransactionCharges, POAttachments.",
  })
  async getFormData(@Query() dto: TransFormQueryDto) {
    return ciSuccess(await this.orders.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID")));
  }

  @Post("addPurchaseOrder")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a purchase order (action = draft saves it unnumbered); TransUID, Token" })
  async addPurchaseOrder(@Body() dto: PurchaseOrderFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.orders.add(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("updatePurchaseOrder")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a purchase order; finalising a draft numbers it (TransUID may change). TransUID, Token" })
  async updatePurchaseOrder(@Body() dto: PurchaseOrderFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.orders.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deletePurchaseOrder")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a purchase order; returns the list page (Data, TotalCount, PageNo, RowLimit)" })
  async deletePurchaseOrder(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.orders.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("updatePurchaseOrderStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Receive, close or cancel an order (NewStatus)" })
  async updatePurchaseOrderStatus(@Body() dto: PurchaseOrderStatusDto, @Req() req: Request) {
    return ciSuccess(await this.orders.updateStatus(writeContext(dto, req), { ...dto }));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("duplicatePurchaseOrder")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicatePurchaseOrder(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.orders.duplicate(writeContext(dto, req), { ...dto }));
  }
}
