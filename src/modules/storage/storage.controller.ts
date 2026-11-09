import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgLangContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { AcceptFiles, AcceptForm, FileFields, filesOf } from "../products/product-files";
import { StorageBulkDeleteDto, StorageFormDto, StorageIdDto, StorageListDto } from "./storage.dto";
import { StorageService } from "./storage.service";

const pageOf = (pathPage: string | undefined, dto: { PageNo?: string | number }) => Math.max(1, Number(pathPage ?? dto.PageNo) || 1);

/** Storage page of CI3 (Storage controller): storage locations products are kept in. Writes answer with the refreshed list page. */
@ApiTags("Storage")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/storage")
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "Page data: EnableStorage, StorageTypeInfo and the first page (Data, TotalCount, PageNo, RowLimit)" })
  async getPageData(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.storage.getPageData(dto.orgId, dto.langCode));
  }

  @Get(["getStorageList", "getStorageList/:pageNo"])
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: "One list page (Data with the image Url, TotalCount, PageNo, RowLimit)" })
  async getStorageList(@Param("pageNo") pageNo: string | undefined, @Query() dto: StorageListDto) {
    return ciSuccess(await this.storage.getPage(dto.orgId, pageOf(pageNo, dto), dto.RowLimit, dto.Filter ?? {}, dto.langCode));
  }

  @Get("getAllStorage")
  @ApiOperation({ summary: "Every storage of the org, for the products page's storage filter (Storage)" })
  async getAllStorage(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.storage.getAll(dto.orgId, dto.langCode));
  }

  @Post("addStorageData")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("UploadImage")
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Create a storage, optional image UploadImage (Message, StorageUID and the refreshed page)" })
  async addStorageData(@Body() dto: StorageFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.storage.save(writeContext(dto, req), { ...dto }, filesOf(files, "UploadImage")[0], false));
  }

  @Post("updateStorageData")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("UploadImage")
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Update a storage (StorageUID); new image UploadImage or ImageRemoved (Message and the refreshed page)" })
  async updateStorageData(@Body() dto: StorageFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.storage.save(writeContext(dto, req), { ...dto }, filesOf(files, "UploadImage")[0], true));
  }

  @Post("deleteStorageDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete a storage, refused while products are kept in it (Message and the refreshed page)" })
  async deleteStorageDetails(@Body() dto: StorageIdDto, @Req() req: Request) {
    return ciSuccess(await this.storage.delete(writeContext(dto, req), { ...dto }, false));
  }

  @Post("deleteBulkStorage")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete several storages (StorageUIDs[]), refused while products are kept in any (Message and the refreshed page)" })
  async deleteBulkStorage(@Body() dto: StorageBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.storage.delete(writeContext(dto, req), { ...dto }, true));
  }
}
