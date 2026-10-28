import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { Request } from "express";
import { writeContext } from "../../core/request/write-context";
import { CustomerGroupWriteService } from "./customer-group-write.service";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { GroupFormDto, GroupIdDto, GroupListDto, GroupStatusDto } from "./dto/customer-group.dto";
import { CustomerGroupsService } from "./customer-groups.service";

// Same /api/customers base and CI3 method names as the customer group calls in the CI3 JS.
@ApiTags("Customer Groups")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/customers")
export class CustomerGroupsController {
  constructor(
    private readonly groupsService: CustomerGroupsService,
    private readonly groupWrite: CustomerGroupWriteService
  ) {}

  @Get("getGroupsData/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Customer group list page (Data, TotalCount, PageNo, RowLimit, Stats)" })
  // Argument order sets the Swagger parameter order: orgId, pageNo, RowLimit, Filter, langCode
  async getGroupsData(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: GroupListDto) {
    return ciSuccess(await this.groupsService.getPage(org.orgId, Number(pageNo) || 1, dto));
  }

  @Get("getGroupStats")
  @ApiOperation({ summary: "Groups tab counters: total, active, inactive, members" })
  async getGroupStats(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.groupsService.getStats(dto.orgId));
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

  @Get("getGroupOutstanding/:groupUID")
  @ApiOperation({ summary: "Each group member's closing balance" })
  async getGroupOutstanding(@Param("groupUID") groupUID: string, @Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.groupsService.getOutstanding(dto.orgId, Number(groupUID), dto.langCode));
  }

  @Get("getGroupsForDropdown")
  @ApiOperation({ summary: "Active groups for the customer form dropdown (also refreshes the Upstash cache)" })
  async getGroupsForDropdown(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.groupsService.getForDropdown(dto.orgId, dto.langCode));
  }

  @Post("syncCustomerGroupsCache")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rebuild the Upstash customer-groups cache from the active groups (Message, Count)" })
  async syncCustomerGroupsCache(@Body() dto: OrgLangContextDto) {
    return ciSuccess(await this.groupsService.syncCache(dto.orgId, dto.langCode));
  }

  @Post("addGroupData")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Create a customer group with its members (Message, GroupUID, GroupName)" })
  async addGroupData(@Body() dto: GroupFormDto, @Req() req: Request) {
    return ciSuccess(await this.groupWrite.create(dto, writeContext(dto, req)));
  }

  @Post("updateGroupData")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update a customer group; MemberUIDs replaces the member list" })
  async updateGroupData(@Body() dto: GroupFormDto, @Req() req: Request) {
    return ciSuccess(await this.groupWrite.update(dto, writeContext(dto, req)));
  }

  @Post("deleteGroup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete a group (members are unlinked); returns the groups page (Data, TotalCount, Stats)" })
  async deleteGroup(@Body() dto: GroupIdDto, @Req() req: Request) {
    return ciSuccess(await this.groupWrite.delete(dto, writeContext(dto, req)));
  }

  @Get("toggleGroupStatus")
  @ApiOperation({ summary: "Activate / deactivate a group; returns the groups page (Data, TotalCount, Stats)" })
  async toggleGroupStatus(@Query() dto: GroupStatusDto, @Req() req: Request) {
    return ciSuccess(await this.groupWrite.setStatus(dto, writeContext(dto, req)));
  }

  @Get("getGroupTypes")
  @ApiOperation({ summary: "Group type names (global list)" })
  async getGroupTypes() {
    return ciSuccess(await this.groupsService.getGroupTypes());
  }
}
