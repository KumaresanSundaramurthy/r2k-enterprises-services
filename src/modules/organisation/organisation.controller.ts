import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UploadedFiles, UseFilters, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { AcceptForm, FileFields } from "../products/product-files";
import { OrganisationFormDto, ShipAddressDto, ShipAddressUpdateDto, VerifyDevPasswordDto } from "./dto/organisation.dto";
import { OrganisationWriteService } from "./organisation-write.service";
import { OrganisationService } from "./organisation.service";

/* Public (no JWT guard) — CI3 calls this server-to-server from both authenticated pages
   and public pages (Doc, Pay, Receipt, Razorpay, Oauth) that have no user JWT cookie.
   Returns org receipt header; DevPassword is excluded by OrgInfoCacheService. */
@ApiTags("Organisation")
@UseFilters(CiExceptionFilter)
@Controller("api/organisation")
export class OrganisationPublicController {
  constructor(private readonly orgInfoCache: OrgInfoCacheService) {}

  @Get("getOrgInfo")
  @ApiOperation({ summary: "Org receipt header from cache: Name, BrandName, Logo, GSTIN, Mobile, Email, billing address (no DevPassword)" })
  async getOrgInfo(@Query() dto: OrgContextDto) {
    return ciSuccess((await this.orgInfoCache.get(dto.orgId)) ?? {});
  }
}

// Settings → Organisation page of CI3 (Organisation controller), same method names as its JS calls.
@ApiTags("Organisation")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/organisation")
export class OrganisationController {
  constructor(
    private readonly organisation: OrganisationService,
    private readonly writes: OrganisationWriteService,
    private readonly orgInfoCache: OrgInfoCacheService
  ) {}

  @Post("verifyDevPassword")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Verifies the developer password for Cachemonitor — returns {Error:false} on match, throws on mismatch (DevPassword never sent to CI3)" })
  async verifyDevPassword(@Body() dto: VerifyDevPasswordDto) {
    const ok = await this.orgInfoCache.verifyDevPassword(dto.orgId, String(dto.password ?? ""));
    if (!ok) throw new Error("Developer password is not configured or does not match.");
    return ciSuccess(null);
  }

  @Get("getOrganisationDetails")
  @ApiOperation({ summary: "Page data: EditOrgData (Logo as CDN URL), BillOrgAddrData, ShipOrgAddrList, MaxShippingAddr" })
  async getOrganisationDetails(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.organisation.getPageData(dto.orgId));
  }

  @Get("getBusinessTypes")
  @ApiOperation({ summary: "Business types (Data: [{ OrgBussTypeUID, Name }])" })
  async getBusinessTypes() {
    return ciSuccess(await this.organisation.getBusinessTypes());
  }

  @Get("getIndustryTypes")
  @ApiOperation({ summary: "Industry types (Data: [{ OrgIndTypeUID, Name }])" })
  async getIndustryTypes() {
    return ciSuccess(await this.organisation.getIndustryTypes());
  }

  @Get("getBusRegTypes")
  @ApiOperation({ summary: "Business registration types (Data: [{ OrgBusRegTypeUID, Name }])" })
  async getBusRegTypes() {
    return ciSuccess(await this.organisation.getBusRegTypes());
  }

  @Post("updateOrgForm")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileFieldsInterceptor([{ name: "UploadImage", maxCount: 1 }]))
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Save the organisation, logo (UploadImage), billing and shipping addresses (Message, BillAddrUID, ShipAddresses)" })
  async updateOrgForm(@Body() dto: OrganisationFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.writes.updateOrganisation(dto, writeContext(dto, req), files?.UploadImage?.[0]));
  }

  @Post("addShipAddress")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add a shipping address within the MaxShippingAddr limit (OrgAddressUID, NewCount, MaxShip, Address)" })
  async addShipAddress(@Body() dto: ShipAddressDto, @Req() req: Request) {
    return ciSuccess(await this.writes.addShipAddress(dto, writeContext(dto, req)));
  }

  @Post("updateShipAddress")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Update a shipping address (OrgAddressUID, Address)" })
  async updateShipAddress(@Body() dto: ShipAddressUpdateDto, @Req() req: Request) {
    return ciSuccess(await this.writes.updateShipAddress(dto, writeContext(dto, req)));
  }
}
