import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { ErpSession } from "../../auth/decorators/erp-session.decorator";
import { ErpSessionGuard } from "../../auth/guards/erp-session.guard";
import { ErpSessionContext } from "../../auth/interfaces/erp-session.interface";
import { setSessionCookie } from "../../auth/utils/session-cookie";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptForm } from "../products/product-files";
import { BranchFormDto, BranchIdDto, BranchListDto, BranchStatusDto, SwitchBranchDto } from "./dto/branch.dto";
import { BranchesService } from "./branches.service";

// Settings → Branches page of CI3 (Branches controller), same method names as its JS calls.
@ApiTags("Branches")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/branches")
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  @Get("getPageDetails/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Branch list page, head office first (Data, TotalCount, PageNo, RowLimit)" })
  // Argument order sets the Swagger parameter order: orgId, pageNo, RowLimit, Filter, langCode
  async getPageDetails(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: BranchListDto) {
    return ciSuccess(await this.branches.getPage(org.orgId, Math.max(1, Number(pageNo) || 1), dto));
  }

  @Get("getBranchTypes")
  @ApiOperation({ summary: "Branch types for the branch form (Data: [{ BranchTypeUID, Name }])" })
  async getBranchTypes() {
    return ciSuccess(await this.branches.getBranchTypes());
  }

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create (BranchUID 0) or update a branch" })
  async save(@Body() dto: BranchFormDto, @Req() req: Request) {
    return ciSuccess(await this.branches.save(dto, writeContext(dto, req)));
  }

  @Post("toggleStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Activate / deactivate a branch (IsActive = its current status)" })
  async toggleStatus(@Body() dto: BranchStatusDto, @Req() req: Request) {
    return ciSuccess(await this.branches.toggleStatus(dto, writeContext(dto, req)));
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete a branch (refused while it has transactions, expenses, income or payroll)" })
  async delete(@Body() dto: BranchIdDto, @Req() req: Request) {
    return ciSuccess(await this.branches.delete(dto, writeContext(dto, req)));
  }

  @Post("setHeadOffice")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Make a branch the organisation's head office" })
  async setHeadOffice(@Body() dto: BranchIdDto, @Req() req: Request) {
    return ciSuccess(await this.branches.setHeadOffice(dto, writeContext(dto, req)));
  }

  // ── CI3 function the JS does not call: migrated, hidden from Swagger ──────────

  @Get("getList")
  @ApiExcludeEndpoint()
  async getList(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.branches.getList(dto.orgId, dto.langCode));
  }
}

// Navbar branch switcher: changes the logged-in session, so it runs on the session (cookie or Bearer session token)
@ApiTags("Branches")
@ApiBearerAuth()
@UseGuards(ErpSessionGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/branches")
export class BranchSessionController {
  constructor(private readonly branches: BranchesService) {}

  @Post("switchBranch")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Switch the session's active branch (BranchUID, BranchName, BranchCode)" })
  async switchBranch(@Body() dto: SwitchBranchDto, @ErpSession() session: ErpSessionContext, @Res({ passthrough: true }) res: Response) {
    const result = await this.branches.switchBranch(postInt(dto, "BranchUID"), session);
    // CI3 re-sets the JWT cookie with a refreshed expiry
    setSessionCookie(res, session.token, Number(process.env.LOGIN_EXPIRE_SECS) || 7200);
    return ciSuccess(result);
  }
}
