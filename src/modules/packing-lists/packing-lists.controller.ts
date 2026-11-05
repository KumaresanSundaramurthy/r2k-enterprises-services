import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptForm } from "../products/product-files";
import { PackingListsService } from "./packing-lists.service";

export class PackingListSourceQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number, description: "The source transaction (DC, invoice, ...)" }) @Allow() TransUID?: string | number;
}

export class PackingListSaveDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number, description: "The source transaction" }) @Allow() TransUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "The packing list being edited (0 / empty = new)" }) @Allow() PLUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD (default today)" }) @Allow() PLDate?: string;
  @ApiPropertyOptional() @Allow() VehicleNumber?: string;
  @ApiPropertyOptional() @Allow() LRNumber?: string;
  @ApiPropertyOptional() @Allow() TransporterName?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ description: "JSON array [{ TransProductUID, ProductUID, Quantity, PackageKind, NumberOfPackages, NetWeight, GrossWeight, CBM }]" })
  @Allow()
  items?: string;
}

/** Packing Lists of CI3 (Packinglists controller, routes packing-list/...): one per dispatching transaction. */
@ApiTags("Packing Lists")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/packinglists")
export class PackingListsController {
  constructor(private readonly packingLists: PackingListsService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "All packing lists of the org, newest first, with the source document's number and party (PLList)" })
  async getPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.packingLists.getPageData(dto.orgId));
  }

  @Get("getFormData")
  @ApiOperation({ summary: "Packing list form of a transaction: SrcHeader, SrcItems, PL (null when none yet), PLItems, OrgInfo" })
  async getFormData(@Query() dto: PackingListSourceQueryDto) {
    return ciSuccess(await this.packingLists.getFormData(dto.orgId, postInt(dto, "TransUID")));
  }

  @Get("getPrintData")
  @ApiOperation({ summary: "Print data (printPL): DCHeader, PL, PLItems (the transaction's lines when no packing list is saved), OrgInfo" })
  async getPrintData(@Query() dto: PackingListSourceQueryDto) {
    return ciSuccess(await this.packingLists.getPrintData(dto.orgId, postInt(dto, "TransUID")));
  }

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create or update a transaction's packing list (PLUID, PrintURL)" })
  async save(@Body() dto: PackingListSaveDto, @Req() req: Request) {
    return ciSuccess(await this.packingLists.save(writeContext(dto, req), { ...dto }));
  }
}
