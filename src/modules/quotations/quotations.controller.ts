import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
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
import { QuotationsService } from "./quotations.service";

export class QuotationFormDto extends TransFormDto {
  @ApiPropertyOptional({ enum: ["Quotation", "Estimate"], description: "Document type" }) @Allow() quotationType?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD; from validityDays when empty" }) @Allow() validityDate?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() validityDays?: string | number;
}

export class QuotationFormQueryDto extends TransFormQueryDto {
  @ApiPropertyOptional({ type: Number, description: "New form pre-filled from this quotation" }) @Allow() fromQuotation?: string | number;
}

export class QuotationConvertDto extends TransChangeDto {
  @ApiPropertyOptional({ enum: ["Invoice", "SalesOrder"], default: "Invoice" }) @Allow() ConvertTarget?: string;
}

export class QuotationStatusDto extends TransChangeDto {
  @ApiProperty({ enum: ["Pending", "Accepted", "Cancelled", "Converted"], description: "Draft → Pending; Pending → Accepted / Cancelled; Accepted → Pending / Cancelled / Converted" })
  @Allow()
  Status?: string;
}

/**
 * Quotations page of CI3 (Quotations controller), same method names as its JS calls. The list, print, files and
 * bulk delete are the shared /api/transactions endpoints (module 101).
 */
@ApiTags("Quotations")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/quotations")
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers, message templates, CommOrgContext" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.quotations.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description:
      "PrefixData, NextNumberMap, DispatchAddresses, fltStorageData, AdditionalCharges, TaxList, DefaultValidityDays / Date; " +
      "edit (TransUID): QuotData, QuotItems, CustAddr, QuotAttachments, TransactionCharges; new from fromQuotation: CloneData, CloneItems.",
  })
  async getFormData(@Query() dto: QuotationFormQueryDto) {
    return ciSuccess(await this.quotations.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID"), postInt(dto, "fromQuotation")));
  }

  @Post("addQuotation")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a quotation (action = draft saves it unnumbered); TransUID, Token" })
  async addQuotation(@Body() dto: QuotationFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.quotations.add(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("updateQuotation")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a quotation; finalising a draft numbers it (TransUID may change). TransUID, Token" })
  async updateQuotation(@Body() dto: QuotationFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.quotations.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deleteQuotation")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a quotation; returns the list page (Data, TotalCount, PageNo, RowLimit)" })
  async deleteQuotation(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.quotations.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("convertQuotationToInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Where to continue a conversion (RedirectURL to the invoice or sales order form)" })
  async convertQuotationToInvoice(@Body() dto: QuotationConvertDto) {
    return ciSuccess(this.quotations.convert({ ...dto }));
  }

  @Post("updateQuotationStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Change a quotation's status (NewStatus)" })
  async updateQuotationStatus(@Body() dto: QuotationStatusDto, @Req() req: Request) {
    return ciSuccess(await this.quotations.updateStatus(writeContext(dto, req), { ...dto }));
  }
}
