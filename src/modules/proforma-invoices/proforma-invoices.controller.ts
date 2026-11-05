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
import { ProformaInvoicesService } from "./proforma-invoices.service";

export class ProformaFormDto extends TransFormDto {
  @ApiPropertyOptional({ description: "Document type (default Regular)" }) @Allow() invoiceType?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (valid until)" }) @Allow() validityDate?: string;
}

export class ProformaStatusDto extends TransChangeDto {
  @ApiProperty({ enum: ["Sent", "Converted", "Expired", "Cancelled"], description: "Draft → Sent; Sent → Converted / Expired / Cancelled; Expired → Sent" })
  @Allow()
  Status?: string;
}

/**
 * Pro Forma Invoices page of CI3 (Proformainvoices controller, routes proforma/...), same method names as its JS
 * calls. The list, print, files and bulk delete are the shared /api/transactions endpoints (module 113).
 */
@ApiTags("Pro Forma Invoices")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/proforma")
export class ProformaInvoicesController {
  constructor(private readonly proformas: ProformaInvoicesService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "List page data: saved date range, InitTab / InitFilter, SummaryStats, OrgUsers" })
  async getPageData(@Query() dto: TransPageDataDto) {
    return ciSuccess(await this.proformas.getPageData(dto.orgId, dto.branchId, dto.userId, String(dto.tab ?? ""), String(dto.search ?? "")));
  }

  @Get("getFormData")
  @ApiOperation({
    summary: "Create / edit form data",
    description: "PrefixData, NextNumberMap, DispatchAddresses, fltStorageData, AdditionalCharges, TaxList; edit (TransUID): PFData, PFItems, CustAddr, TransactionCharges, PFAttachments.",
  })
  async getFormData(@Query() dto: TransFormQueryDto) {
    return ciSuccess(await this.proformas.getFormData(dto.orgId, dto.langCode, postInt(dto, "TransUID")));
  }

  @Post("addProFormaInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a pro forma invoice (action = draft saves it unnumbered); TransUID, Token" })
  async addProFormaInvoice(@Body() dto: ProformaFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.proformas.add(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("updateProFormaInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptEntryFiles()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a pro forma invoice in place; TransUID, Token" })
  async updateProFormaInvoice(@Body() dto: ProformaFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.proformas.update(writeContext(dto, req), { ...dto }, recordFiles(files)));
  }

  @Post("deleteProFormaInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a pro forma invoice; returns the list page" })
  async deleteProFormaInvoice(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.proformas.delete(writeContext(dto, req), { ...dto }));
  }

  @Post("duplicateProFormaInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Copy a pro forma invoice as a Draft dated today (TransUID, EditURL)" })
  async duplicateProFormaInvoice(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.proformas.duplicate(writeContext(dto, req), { ...dto }));
  }

  @Post("updateProFormaStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Change a pro forma's status; returns the list page" })
  async updateProFormaStatus(@Body() dto: ProformaStatusDto, @Req() req: Request) {
    return ciSuccess(await this.proformas.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Post("convertProFormaToInvoice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark a Sent pro forma Converted; RedirectURL opens the invoice form from it" })
  async convertProFormaToInvoice(@Body() dto: TransChangeDto, @Req() req: Request) {
    return ciSuccess(await this.proformas.convert(writeContext(dto, req), { ...dto }));
  }
}
