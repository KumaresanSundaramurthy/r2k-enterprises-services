import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UploadedFiles, UseFilters, UseGuards, UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { AcceptForm, FileFields } from "../products/product-files";
import { OrganisationFormDto, ShipAddressDto, ShipAddressUpdateDto } from "./dto/organisation.dto";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { OrganisationWriteService } from "./organisation-write.service";
import { OrganisationService } from "./organisation.service";

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

  @Get("getOrgInfo")
  @ApiOperation({ summary: "Org receipt header from cache: Name, BrandName, Logo, GSTIN, Mobile, Email, billing address (no DevPassword)" })
  async getOrgInfo(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.orgInfoCache.get(dto.orgId));
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
