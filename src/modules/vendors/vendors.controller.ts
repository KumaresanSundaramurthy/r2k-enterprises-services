import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, StreamableFile, UploadedFiles, UseFilters, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt, postIntList, postString } from "../../core/utils/form-values";
import { CommunicationDto } from "../../libraries/communication/communication.dto";
import { CommunicationService } from "../../libraries/communication/communication.service";
import { VendorFormDto } from "./dto/vendor-form.dto";
import { VendorExportDto, VendorListDto, VendorSearchListDto } from "./dto/vendor-list.dto";
import {
  VendorAttachmentDeleteDto,
  VendorAttachmentsDto,
  VendorBillingAddressDto,
  VendorBulkDeleteDto,
  VendorIdDto,
  VendorModalFormDto,
  VendorNoteDto,
  VendorOpeningBalanceDto,
  VendorOpeningBalanceSaveDto,
  VendorStatementDto,
  VendorStatusDto,
  VendorUpdateDto,
} from "./dto/vendor-write.dto";
import { VendorAccountService } from "./vendor-account.service";
import { VendorAttachmentService } from "./vendor-attachment.service";
import { VendorCacheService } from "./vendor-cache.service";
import { VendorExportService } from "./vendor-export.service";
import { VendorProfileService } from "./vendor-profile.service";
import { VendorWriteService } from "./vendor-write.service";
import { VendorsService } from "./vendors.service";

// Vendor images arrive as VendAttachFiles[] (the CI3 FormData name) or VendAttachFiles
const AttachFiles = () =>
  UseInterceptors(
    FileFieldsInterceptor([
      { name: "VendAttachFiles[]", maxCount: 10 },
      { name: "VendAttachFiles", maxCount: 10 },
    ])
  );
type FileFields = Record<string, Express.Multer.File[]> | undefined;
const attachedFiles = (files: FileFields) => [...(files?.["VendAttachFiles[]"] ?? []), ...(files?.VendAttachFiles ?? [])];

/**
 * Routes keep CI3's method names so each JS call maps one-to-one to its old /vendors/... URL. Endpoints the
 * CI3 JS calls are listed in Swagger; the other CI3 functions are migrated too but hidden from the docs.
 */
@ApiTags("Vendors")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/vendors")
export class VendorsController {
  constructor(
    private readonly vendorsService: VendorsService,
    private readonly vendorWrite: VendorWriteService,
    private readonly vendorAccount: VendorAccountService,
    private readonly vendorProfile: VendorProfileService,
    private readonly vendorCache: VendorCacheService,
    private readonly vendorExport: VendorExportService,
    private readonly vendorAttachments: VendorAttachmentService,
    private readonly communication: CommunicationService
  ) {}

  @Get("getVendorsPageDetails/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Vendor list page (Data, TotalCount, PageNo, RowLimit)" })
  // Argument order sets the Swagger parameter order: orgId, pageNo, RowLimit, Filter, langCode
  async getVendorsPageDetails(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: VendorListDto) {
    return ciSuccess(await this.vendorsService.getPage(org.orgId, Number(pageNo) || 1, dto));
  }

  @Get("getVendorForModal/:uid")
  @ApiOperation({ summary: "One vendor with bank details, addresses and attachments (edit form)" })
  async getVendorForModal(@Param("uid") uid: string, @Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.vendorsService.getDetail(dto.orgId, Number(uid), dto.langCode));
  }

  @Get("getNextVendorNumber")
  @ApiOperation({ summary: "Next vendor number for the new-vendor form (VendorNumber)" })
  async getNextVendorNumber(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.vendorsService.getNextNumber(dto.orgId));
  }

  @Get("getVendorSearchList")
  @ApiOperation({ summary: "Vendor picker of the purchase forms with balance and billing address (Vendors, TotalCount)" })
  async getVendorSearchList(@Query() dto: VendorSearchListDto) {
    return ciSuccess(await this.vendorsService.searchWithBalance(dto));
  }

  @Post("addVendorData")
  @HttpCode(HttpStatus.OK)
  @AttachFiles()
  @ApiConsumes("application/json", "multipart/form-data")
  @ApiOperation({
    summary: "Create a vendor (with addresses, bank details, ledger, opening balance and customer link)",
    description:
      "Validation errors return { Error: true, Message, FieldErrors: { field: message } }. Images are sent as VendAttachFiles[]. " +
      "On success: Message, VendorUID, VendorName, VendorArea and Vendor ({ VendorUID, Name, Area, MobileNumber, Address }).",
  })
  async addVendorData(@Body() dto: VendorFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.vendorWrite.create(dto, writeContext(dto, req), attachedFiles(files)));
  }

  @Post("updateVendorData")
  @HttpCode(HttpStatus.OK)
  @AttachFiles()
  @ApiConsumes("application/json", "multipart/form-data")
  @ApiOperation({
    summary: "Update a vendor (same fields as create, plus VendorUID, bank/address deletions and VendAttachDeleteUIDs)",
    description: "Validation errors return FieldErrors like create. On success: Message and Vendor.",
  })
  async updateVendorData(@Body() dto: VendorUpdateDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.vendorWrite.update(dto, writeContext(dto, req), attachedFiles(files)));
  }

  @Post("toggleVendorStatus")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Activate (IsActive = 1) or deactivate (0) a vendor" })
  async toggleVendorStatus(@Body() dto: VendorStatusDto, @Req() req: Request) {
    return ciSuccess(await this.vendorWrite.setStatus(dto, writeContext(dto, req)));
  }

  @Post("deleteVendorData")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft-delete a vendor and deactivate its ledger (refused if it has transactions)" })
  async deleteVendorData(@Body() dto: VendorIdDto, @Req() req: Request) {
    return ciSuccess(await this.vendorWrite.delete(dto, writeContext(dto, req)));
  }

  @Post("deleteMultipleVendors")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Soft-delete several vendors, or all matching a filter (SelectAll = 1); all or nothing" })
  async deleteMultipleVendors(@Body() dto: VendorBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.vendorWrite.deleteBulk(dto, writeContext(dto, req)));
  }

  @Post("updateBillingAddress")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update (or add) a vendor's billing address from the purchase forms" })
  async updateBillingAddress(@Body() dto: VendorBillingAddressDto, @Req() req: Request) {
    return ciSuccess(await this.vendorWrite.updateBillingAddress(dto, writeContext(dto, req)));
  }

  @Post("syncVendorsCache")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rebuild the Upstash vendors cache from every active vendor (Message, Count)" })
  async syncVendorsCache(@Body() dto: OrgContextDto) {
    return ciSuccess(await this.vendorCache.syncAll(dto.orgId));
  }

  @Get("getVendorProfileTab/:uid/:tab")
  @ApiParam({ name: "tab", enum: ["overview", "transactions", "statement", "notes"] })
  @ApiOperation({ summary: "Vendor profile tab as data (Tab, Data) — CI3 returned it as HTML" })
  async getVendorProfileTab(@Param("uid") uid: string, @Param("tab") tab: string, @Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.vendorProfile.getTab(dto.orgId, Number(uid), tab, dto.langCode));
  }

  @Get("getVendorStatementTab")
  @ApiOperation({ summary: "Vendor statement for a date range (purchases, payments, returns) with org header" })
  async getVendorStatementTab(@Query() dto: VendorStatementDto) {
    return ciSuccess(await this.vendorProfile.getStatement(dto.orgId, postInt(dto, "VendorUID"), dto.FromDate, dto.ToDate, dto.langCode));
  }

  @Post("saveVendorNote")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add a note to a vendor" })
  async saveVendorNote(@Body() dto: VendorNoteDto, @Req() req: Request) {
    return ciSuccess(await this.vendorWrite.addNote(dto, writeContext(dto, req)));
  }

  @Post("sendCommunication")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: "Attachments[]", maxCount: 10 },
      { name: "Attachments", maxCount: 10 },
    ])
  )
  @ApiConsumes("application/json", "multipart/form-data")
  @ApiOperation({
    summary: "Send an SMS or email to selected vendors (Message, Sent, Failed)",
    description: "Email takes up to 3 attachments (pdf / jpg / jpeg / png) as Attachments[]. Each attempt is logged in Security.CommunicationLogTbl.",
  })
  async sendCommunication(@Body() dto: CommunicationDto, @UploadedFiles() files: FileFields) {
    return ciSuccess(
      await this.communication.send(dto.orgId, dto.userId, "Vendor", {
        commType: postString(dto, "CommType") ?? "",
        message: postString(dto, "Message") ?? "",
        subject: postString(dto, "Subject") ?? "",
        uids: postIntList(dto, "UIDs"),
        files: [...(files?.["Attachments[]"] ?? []), ...(files?.Attachments ?? [])],
      })
    );
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ─────────

  @Get(["loadModalForm/:type", "loadModalForm/:type/:uid"])
  @ApiExcludeEndpoint()
  async loadModalForm(@Param("type") type: string, @Param("uid") uid: string | undefined, @Query() dto: VendorModalFormDto) {
    return ciSuccess(await this.vendorsService.getModalForm(dto.orgId, type, Number(uid ?? dto.uid) || 0, dto.langCode));
  }

  @Get("exportVendors")
  @ApiExcludeEndpoint()
  async exportVendors(@Query() dto: VendorExportDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.vendorExport.export(dto);
    if (result.kind === "html") return ciSuccess({ HtmlData: result.html });
    res.set({
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Access-Control-Expose-Headers": "Content-Disposition",
      Pragma: "no-cache",
    });
    return new StreamableFile(result.body);
  }

  @Get("getVendorTags")
  @ApiExcludeEndpoint()
  async getVendorTags(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.vendorsService.getTags(dto.orgId));
  }

  @Get("getStats")
  @ApiExcludeEndpoint()
  async getStats(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.vendorsService.getStats(dto.orgId));
  }

  @Get("getVendorOpeningBalance")
  @ApiExcludeEndpoint()
  async getVendorOpeningBalance(@Query() dto: VendorOpeningBalanceDto) {
    return ciSuccess(await this.vendorsService.getOpeningBalance(dto));
  }

  @Post("saveVendorOpeningBalance")
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async saveVendorOpeningBalance(@Body() dto: VendorOpeningBalanceSaveDto, @Req() req: Request) {
    return ciSuccess(await this.vendorAccount.saveOpeningBalance(dto, writeContext(dto, req)));
  }

  @Post("updateVendorBalance")
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async updateVendorBalance(@Body() dto: VendorIdDto, @Req() req: Request) {
    return ciSuccess(await this.vendorAccount.updateStoredBalances(dto, writeContext(dto, req)));
  }

  @Post("recalcBalance")
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async recalcBalance(@Body() dto: VendorIdDto, @Req() req: Request) {
    return ciSuccess(await this.vendorAccount.recalculate(dto, writeContext(dto, req)));
  }

  @Get("getVendorAttachments")
  @ApiExcludeEndpoint()
  async getVendorAttachments(@Query() dto: VendorAttachmentsDto) {
    return ciSuccess(await this.vendorAttachments.list(dto.orgId, postInt(dto, "VendorUID")));
  }

  @Post("deleteVendorAttachment")
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async deleteVendorAttachment(@Body() dto: VendorAttachmentDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.vendorAttachments.deleteOne(writeContext(dto, req), postInt(dto, "AttachUID"), postInt(dto, "VendorUID")));
  }
}
