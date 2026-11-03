import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto, OrgUserContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptForm } from "../products/product-files";
import { ClaimsRequest, sessionKeyOf } from "../session-sync/session-sync.service";
import { RolesService } from "./roles.service";

const PERMISSIONS_DESCRIPTION = "Array (or JSON) of { MainMenuUID | SubMenuUID, CanView, CanCreate, CanEdit, CanDelete, Sorting }";

export class RoleQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() RoleUID?: string | number;
}

export class RoleIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() RoleUID?: string | number;
}

export class RolePermissionsDto extends RoleIdDto {
  @ApiPropertyOptional({ description: PERMISSIONS_DESCRIPTION }) @Allow() MainMenus?: unknown;
  @ApiPropertyOptional({ description: PERMISSIONS_DESCRIPTION }) @Allow() SubMenus?: unknown;
}

// The role is stored with the branch the user is working in (CI3 JwtData->Org->BranchUID)
export class RoleFormDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ description: "0 / empty = new role" }) @Allow() RoleUID?: string | number;
  @ApiProperty() @Allow() RoleName?: string;
  @ApiPropertyOptional({ description: PERMISSIONS_DESCRIPTION }) @Allow() MainMenus?: unknown;
  @ApiPropertyOptional({ description: PERMISSIONS_DESCRIPTION }) @Allow() SubMenus?: unknown;
}

// Settings → Roles page of CI3 (Roles controller), same method names as its JS calls.
@ApiTags("Roles")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/roles")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "Page data: RolesList, AllMainMenus, AllSubMenus (permission matrix)" })
  async getPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.roles.getPageData(dto.orgId));
  }

  @Get("getRolePermissions")
  @ApiOperation({ summary: "A role's permissions (Data: { main, sub })" })
  async getRolePermissions(@Query() dto: RoleQueryDto) {
    return ciSuccess(await this.roles.getPermissions(dto.orgId, postInt(dto, "RoleUID")));
  }

  @Post("saveRole")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create / rename a role, with permissions when posted (UID)" })
  async saveRole(@Body() dto: RoleFormDto, @Req() req: Request) {
    return ciSuccess(await this.roles.save({ ...dto }, writeContext(dto, req), dto.branchId));
  }

  @Post("saveRolePermissions")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save a role's permissions; refreshes the session and the org-info cache" })
  async saveRolePermissions(@Body() dto: RolePermissionsDto, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.roles.savePermissions({ ...dto }, writeContext(dto, req), sessionKeyOf(req)));
  }

  @Post("deleteRole")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a role (not global, default or assigned)" })
  async deleteRole(@Body() dto: RoleIdDto, @Req() req: Request) {
    return ciSuccess(await this.roles.delete(postInt(dto, "RoleUID"), writeContext(dto, req)));
  }

  // ── CI3 function the JS does not call: migrated, hidden from Swagger ──────────

  @Get("getRolesList")
  @ApiExcludeEndpoint()
  async getRolesList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.roles.getList(dto.orgId));
  }
}
