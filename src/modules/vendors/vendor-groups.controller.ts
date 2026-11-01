import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { SearchVendorsDto } from "./dto/vendor-list.dto";
import { VendorGroupFormDto, VendorGroupIdDto, VendorGroupListDto, VendorGroupStatusDto } from "./dto/vendor-group.dto";
import { VendorGroupWriteService } from "./vendor-group-write.service";
import { VendorGroupsService } from "./vendor-groups.service";

// Same /api/vendors base and CI3 method names as the vendor group calls in the CI3 JS.
@ApiTags("Vendor Groups")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/vendors")
export class VendorGroupsController {
  constructor(
    private readonly groupsService: VendorGroupsService,
    private readonly groupWrite: VendorGroupWriteService
  ) {}

  @Get("getGroupsData/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Vendor group list page (Data, TotalCount, PageNo, RowLimit, Stats)" })
  // Argument order sets the Swagger parameter order: orgId, pageNo, RowLimit, Filter, langCode
  async getGroupsData(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: VendorGroupListDto) {
    return ciSuccess(await this.groupsService.getPage(org.orgId, Number(pageNo) || 1, dto));
  }

  @Get("getGroupForModal/:groupUID")
  @ApiOperation({ summary: "Group with members (edit form)" })
  async getGroupForModal(@Param("groupUID") groupUID: string, @Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.groupsService.getForModal(dto.orgId, Number(groupUID), dto.langCode));
  }

  @Get("getGroupDetail/:groupUID")
  @ApiOperation({ summary: "Group with members and overview totals" })
  async getGroupDetail(@Param("groupUID") groupUID: string, @Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.groupsService.getDetail(dto.orgId, Number(groupUID), dto.langCode));
  }

  @Get("getGroupTypes")
  @ApiOperation({ summary: "Vendor group type names (global list)" })
  async getGroupTypes() {
    return ciSuccess(await this.groupsService.getGroupTypes());
  }

  @Get("searchVendors")
  @ApiOperation({ summary: "Group form typeahead (Lists: [{ id, text }], max 10; vendors in other groups left out)" })
  async searchVendors(@Query() dto: SearchVendorsDto) {
    return ciSuccess(await this.groupsService.searchVendors(dto));
  }

  @Post("syncVendorGroupsCache")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rebuild the Upstash vendor-groups cache from the active groups (Message, Count)" })
  async syncVendorGroupsCache(@Body() dto: OrgLangContextDto) {
    return ciSuccess(await this.groupsService.syncCache(dto.orgId, dto.langCode));
  }

  @Post("addGroupData")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Create a vendor group with its members (Message, GroupUID)" })
  async addGroupData(@Body() dto: VendorGroupFormDto, @Req() req: Request) {
    return ciSuccess(await this.groupWrite.create(dto, writeContext(dto, req)));
  }

  @Post("updateGroupData")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update a vendor group; MemberUIDs replaces the member list (Message, GroupUID)" })
  async updateGroupData(@Body() dto: VendorGroupFormDto, @Req() req: Request) {
    return ciSuccess(await this.groupWrite.update(dto, writeContext(dto, req)));
  }

  @Post("deleteGroup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a group (members are unlinked); returns the groups page (Data, TotalCount, Stats)" })
  async deleteGroup(@Body() dto: VendorGroupIdDto, @Req() req: Request) {
    return ciSuccess(await this.groupWrite.delete(dto, writeContext(dto, req)));
  }

  @Post("toggleGroupStatus")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Activate / deactivate a group; returns the groups page (Data, TotalCount, Stats)" })
  async toggleGroupStatus(@Body() dto: VendorGroupStatusDto, @Req() req: Request) {
    return ciSuccess(await this.groupWrite.setStatus(dto, writeContext(dto, req)));
  }

  // ── CI3 function the JS does not call: migrated, hidden from Swagger ──────────

  @Get("getGroupsForDropdown")
  @ApiExcludeEndpoint()
  async getGroupsForDropdown(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.groupsService.getForDropdown(dto.orgId, dto.langCode));
  }
}
