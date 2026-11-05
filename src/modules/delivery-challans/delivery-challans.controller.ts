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
import { SalesDocQueryDto } from "../invoices/invoices.dto";
import { TransChangeDto, TransFormDto, TransFormQueryDto, TransPageDataDto } from "../transactions/transaction-form.dto";
import { DeliveryChallansService } from "./delivery-challans.service";

export class DeliveryChallanFormDto extends TransFormDto {
  @ApiPropertyOptional({ enum: ["Non-Returnable", "Returnable", "Job Work"], description: "Challan type (default Non-Returnable)" }) @Allow() challanType?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (expected return / delivery date)" }) @Allow() returnDate?: string;
  @ApiPropertyOptional({ description: "Delivered by" }) @Allow() deliveryBy?: string;
  @ApiPropertyOptional({ description: "Vehicle number (stored as the reference)" }) @Allow() vehicleNumber?: string;
  @ApiPropertyOptional({ type: Number, description: "addDeliveryChallan: the sales order it dispatches (customer, items and quantities locked to it)" }) @Allow() fromSOUID?: string | number;
}

export class DeliveryChallanFormQueryDto extends TransFormQueryDto {
  @ApiPropertyOptional({ type: Number, description: "New challan from this sales order" }) @Allow() fromSalesOrder?: string | number;
  @ApiPropertyOptional({ type: Number, description: "New challan copied from this challan" }) @Allow() fromClone?: string | number;
}

export class DeliveryChallanStatusDto extends TransChangeDto {
  @ApiProperty({ enum: ["Dispatched", "Delivered", "Returned", "Cancelled"], description: "Draft → Dispatched; Dispatched → Delivered / Cancelled (Returnable, Job Work: Returned / Cancelled)" })
  @Allow()
  Status?: string;
}

export class PartialReturnDto extends TransChangeDto {
  @ApiProperty({ description: 'JSON array [{"TransProdUID":1,"ReturnQty":2}]' }) @Allow() ReturnItems?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
}

/**
 * Delivery Challans page of CI3 (Deliverychallans controller, routes deliverychallan/...), same method names as its
 * JS calls. The list, print, files and bulk delete are the shared /api/transactions endpoints (module 112).
 */
@ApiTags("Delivery Challans")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/deliverychallan")
export class DeliveryChallansController {
  constructor(private readonly challans: DeliveryChallansService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.challans.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description:
      "PrefixData, NextNumberMap, DispatchAddresses, AdditionalCharges, TaxList; new: FromSOUID, SOSourceData, SOSourceItems, FromCloneUID, CloneData, CloneItems; edit (TransUID): DCData, DCItems, CustAddr, TransactionCharges, DCAttachments.",
  })
  async getFormData(@Query() dto: DeliveryChallanFormQueryDto) {
    return ciSuccess(await this.challans.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID"), postInt(dto, "fromSalesOrder"), postInt(dto, "fromClone")));
  }

  @Post("addDeliveryChallan")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a delivery challan (action = draft saves it unnumbered); a saved challan takes stock out and converts its sales order. TransUID, Token" })
  async addDeliveryChallan(@Body() dto: DeliveryChallanFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.challans.add(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("updateDeliveryChallan")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a delivery challan in place; its stock movement is redone. TransUID, Token" })
  async updateDeliveryChallan(@Body() dto: DeliveryChallanFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.challans.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deleteDeliveryChallan")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a delivery challan (stock that went out comes back); returns the list page" })
  async deleteDeliveryChallan(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.challans.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("updateDeliveryChallanStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Change a challan's status (Returned / Cancelled from Dispatched restore stock); NewStatus + the list page" })
  async updateDeliveryChallanStatus(@Body() dto: DeliveryChallanStatusDto, @Req() req: Request) {
    return ciSuccess(await this.challans.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Get("getPartialReturnData")
  @ApiOperation({ summary: "A Dispatched / Partially Returned challan's lines with DispatchedQty, ReturnedQty, StillOut (DC, Items)" })
  async getPartialReturnData(@Query() dto: SalesDocQueryDto) {
    return ciSuccess(await this.challans.partialReturnData(dto.orgId, postInt(dto, "TransUID")));
  }

  @Post("partialReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Record goods returned against a challan (stock in); status becomes Returned or Partially Returned. NewStatus + the list page" })
  async partialReturn(@Body() dto: PartialReturnDto, @Req() req: Request) {
    return ciSuccess(await this.challans.partialReturn(writeContext(dto, req), { ...dto }));
  }

  @Post("convertChallanToInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark a Delivered challan Converted; RedirectURL opens the invoice form from it" })
  async convertChallanToInvoice(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.challans.convert(writeContext(dto, req), { ...dto }));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("duplicateDeliveryChallan")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async duplicateDeliveryChallan(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.challans.duplicate(writeContext(dto, req), { ...dto }));
  }
}
