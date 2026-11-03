import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Response } from "express";
import { Readable } from "stream";
import { ReadableStream } from "stream/web";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptFiles, AcceptForm, FileFields, filesOf } from "../products/product-files";
import { DriveService } from "./drive.service";

// userId is the caller; ViewUserUID lets a Super Admin work in another user's drive
export class DriveDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "Super Admin only: whose drive (default: the caller's)" }) @Allow() ViewUserUID?: string | number;
}

export class DriveFolderDto extends DriveDto {
  @ApiPropertyOptional({ description: "Folder (0 / empty = root)" }) @Allow() ParentUID?: string | number;
}

export class CreateFolderDto extends DriveFolderDto {
  @ApiProperty({ description: "Max 255 characters" }) @Allow() FolderName?: string;
}

export class UploadFilesDto extends DriveFolderDto {
  @ApiProperty({ type: "array", items: { type: "string", format: "binary" }, description: "Files[] (100 MB per user in total)" }) Files?: unknown;
}

export class DriveItemDto extends DriveDto {
  @ApiProperty({ type: Number }) @Allow() DriveItemUID?: string | number;
}

export class MoveItemDto extends DriveItemDto {
  @ApiProperty({ type: Number, description: "Destination folder (0 = root)" }) @Allow() NewParentUID?: string | number;
}

export class RenameItemDto extends DriveItemDto {
  @ApiProperty() @Allow() NewName?: string;
}

// Settings → My Drive page of CI3 (Drive controller), same method names as its JS calls.
@ApiTags("My Drive")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/mydrive")
export class DriveController {
  constructor(private readonly drive: DriveService) {}

  private context(dto: DriveDto) {
    return this.drive.context(dto.orgId, dto.userId, postInt(dto, "ViewUserUID"));
  }

  @Get("getPageData")
  @ApiOperation({ summary: "Page data: IsAdmin, CurrentUserUID, QuotaBytes, OrgUsers (Super Admin), CdnUrl" })
  async getPageData(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.drive.getPageData(dto.orgId, dto.userId));
  }

  @Get("getItems")
  @ApiOperation({ summary: "A folder's contents (Items, Breadcrumb, UsedBytes, QuotaBytes)" })
  async getItems(@Query() dto: DriveFolderDto) {
    return ciSuccess(await this.drive.getItems(await this.context(dto), postInt(dto, "ParentUID")));
  }

  @Post("createFolder")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create a folder (DriveItemUID)" })
  async createFolder(@Body() dto: CreateFolderDto) {
    return ciSuccess(await this.drive.createFolder(await this.context(dto), postInt(dto, "ParentUID"), String(dto.FolderName ?? "")));
  }

  @Post("uploadFile")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("Files")
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Upload files into a folder (Added, Errors, UsedBytes)" })
  async uploadFile(@Body() dto: UploadFilesDto, @UploadedFiles() files: FileFields) {
    return ciSuccess(await this.drive.upload(await this.context(dto), postInt(dto, "ParentUID"), filesOf(files, "Files")));
  }

  @Post("moveItem")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Move a file / folder" })
  async moveItem(@Body() dto: MoveItemDto) {
    return ciSuccess(await this.drive.move(await this.context(dto), postInt(dto, "DriveItemUID"), postInt(dto, "NewParentUID")));
  }

  @Post("renameItem")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Rename a file / folder (NewName)" })
  async renameItem(@Body() dto: RenameItemDto) {
    return ciSuccess(await this.drive.rename(await this.context(dto), postInt(dto, "DriveItemUID"), String(dto.NewName ?? "")));
  }

  @Post("deleteItem")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a file / folder with its contents (UsedBytes)" })
  async deleteItem(@Body() dto: DriveItemDto) {
    return ciSuccess(await this.drive.delete(await this.context(dto), postInt(dto, "DriveItemUID")));
  }

  @Get("downloadFile/:driveItemUID")
  @ApiParam({ name: "driveItemUID" })
  @ApiOperation({ summary: "Download a file (streamed as an attachment)" })
  async downloadFile(@Param("driveItemUID") driveItemUID: string, @Query() dto: OrgUserContextDto, @Res() res: Response) {
    const target = await this.drive.downloadTarget(dto.orgId, dto.userId, Number(driveItemUID) || 0);
    if (target === null) return res.status(HttpStatus.NOT_FOUND).type("text/plain").send("File not found.");
    if (target === false) return res.status(HttpStatus.FORBIDDEN).type("text/plain").send("Access denied.");

    const upstream = await fetch(target.url).catch(() => null);
    if (!upstream?.ok || !upstream.body) return res.status(HttpStatus.BAD_GATEWAY).type("text/plain").send("File unavailable.");
    res.setHeader("Content-Type", target.mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(target.name)}"`);
    if (target.size) res.setHeader("Content-Length", String(target.size));
    res.setHeader("Cache-Control", "private, no-cache, no-store");
    Readable.fromWeb(upstream.body as ReadableStream).pipe(res);
  }

  // ── CI3 function the JS does not call: migrated, hidden from Swagger ──────────

  @Get("getUsage")
  @ApiExcludeEndpoint()
  async getUsage(@Query() dto: DriveDto) {
    return ciSuccess(await this.drive.getUsage(await this.context(dto)));
  }
}
