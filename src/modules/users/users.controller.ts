import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { Allow, IsInt, IsOptional, Min } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgPagedListDto } from "../../core/dto/org-context.dto";
import { toJsonObject } from "../../core/dto/transforms";
import { OrgUserBranchContextDto, OrgUserContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptFiles, AcceptForm, FileFields, filesOf } from "../products/product-files";
import { ClaimsRequest, sessionKeyOf } from "../session-sync/session-sync.service";
import { UsersService } from "./users.service";

class UserListFilterDto {
  @ApiPropertyOptional({ enum: ["All", "Active", "Resigned", "Terminated", "OnLeave"] }) @Allow() EmpStatus?: string;
  @ApiPropertyOptional({ description: "1 = login users, 0 = staff without login" }) @Allow() LoginAccess?: string | number;
  @ApiPropertyOptional({ type: [Number] }) @Allow() DeptUIDs?: number[];
  @ApiPropertyOptional({ description: "Matches name, user name, email, employee code or mobile" }) @Allow() Name?: string;
}

export class UserListDto extends OrgPagedListDto {
  @ApiProperty({ type: Number, description: "The caller (salary columns are shown to Super Admin and Admin only)" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;

  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { EmpStatus, LoginAccess, DeptUIDs[], Name }" })
  @IsOptional()
  @Transform(toJsonObject(UserListFilterDto))
  Filter?: UserListFilterDto;
}

export class UsersPageDto extends OrgUserContextDto {
  @ApiPropertyOptional({ enum: ["all", "active", "resigned", "terminated", "onleave"], description: "Status the list opens with" }) @Allow() status?: string;
  @ApiPropertyOptional({ example: "en" }) @Allow() langCode?: string;
}

export class UserQueryDto extends OrgUserContextDto {
  @ApiProperty({ type: Number, description: "The staff member" }) @Allow() UserUID?: string | number;
}

// Changes that answer with the refreshed first page take the list's Filter / RowLimit
class ListEchoDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "JSON filter of the list (as getPageDetails)" }) @Allow() Filter?: string;
  @ApiPropertyOptional() @Allow() RowLimit?: string | number;
}

export class UserStatusDto extends ListEchoDto {
  @ApiProperty({ type: Number }) @Allow() UserUID?: string | number;
  @ApiProperty({ description: "New status: 1 = active, 0 = inactive" }) @Allow() IsActive?: string | number;
}

export class UserAttachmentDto extends OrgUserContextDto {
  @ApiProperty({ type: Number, description: "The staff member" }) @Allow() UserUID?: string | number;
  @ApiPropertyOptional({ example: "General" }) @Allow() DocType?: string;
  @ApiProperty({ type: "string", format: "binary", description: "Max 5 MB" }) AttachFile?: unknown;
}

export class UserAttachmentIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() AttachUID?: string | number;
  @ApiProperty({ type: Number, description: "The staff member (for the returned list)" }) @Allow() UserUID?: string | number;
}

export class LanguageDto extends OrgUserContextDto {
  @ApiProperty({ enum: ["en", "ta"] }) @Allow() UILanguage?: string;
}

// The CI3 staff form, field for field; checked in UsersService with CI3's rules
export class UserFormDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ description: "0 / empty = new staff member" }) @Allow() UserUID?: string | number;
  @ApiProperty() @Allow() FirstName?: string;
  @ApiPropertyOptional() @Allow() LastName?: string;
  @ApiPropertyOptional({ description: "Required for a new login user" }) @Allow() Email?: string;
  @ApiPropertyOptional() @Allow() Mobile?: string;
  @ApiPropertyOptional({ example: "+91" }) @Allow() CountryCode?: string;
  @ApiPropertyOptional({ example: "IN" }) @Allow() CountryISO2?: string;
  @ApiPropertyOptional({ description: "1 = can log in (needs UserName, Email and RoleUID)" }) @Allow() HasLoginAccess?: string | number;
  @ApiPropertyOptional() @Allow() UserName?: string;
  @ApiPropertyOptional() @Allow() RoleUID?: string | number;
  @ApiPropertyOptional() @Allow() IsActive?: string | number;
  @ApiPropertyOptional() @Allow() IsLocked?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD; access ends at 23:59:59 that day" }) @Allow() LoginExpiryDateTime?: string;
  @ApiPropertyOptional({ description: "Kept on edit; a new staff member gets the next code" }) @Allow() EmployeeCode?: string;
  @ApiProperty() @Allow() DepartmentUID?: string | number;
  @ApiProperty() @Allow() DesignationUID?: string | number;
  @ApiPropertyOptional() @Allow() DateOfJoining?: string;
  @ApiPropertyOptional({ enum: ["Active", "Resigned", "Terminated", "OnLeave"] }) @Allow() EmployeeStatus?: string;
  @ApiPropertyOptional({ enum: ["Monthly", "Daily", "Hourly"] }) @Allow() SalaryType?: string;
  @ApiPropertyOptional({ description: "Saved only for Super Admin / Admin callers" }) @Allow() BasicSalary?: string | number;
  @ApiPropertyOptional() @Allow() Allowances?: string | number;
  @ApiPropertyOptional() @Allow() Incentives?: string | number;
  @ApiPropertyOptional() @Allow() FixedDeductions?: string | number;
  @ApiPropertyOptional() @Allow() CurrAddressLine1?: string;
  @ApiPropertyOptional() @Allow() CurrAddressLine2?: string;
  @ApiPropertyOptional() @Allow() CurrCity?: string;
  @ApiPropertyOptional() @Allow() CurrState?: string;
  @ApiPropertyOptional() @Allow() CurrPinCode?: string;
  @ApiPropertyOptional() @Allow() PermAddressLine1?: string;
  @ApiPropertyOptional() @Allow() PermAddressLine2?: string;
  @ApiPropertyOptional() @Allow() PermCity?: string;
  @ApiPropertyOptional() @Allow() PermState?: string;
  @ApiPropertyOptional() @Allow() PermPinCode?: string;
  @ApiPropertyOptional({ description: "Comma-separated AddressUIDs to remove" }) @Allow() DelAddrUIDs?: string;
  @ApiPropertyOptional({ description: "JSON array of { BranchUID, IsDefault } (replaces the user's branches)" }) @Allow() BranchAccessJson?: string;
  @ApiPropertyOptional({ description: "JSON filter of the list (for the returned first page)" }) @Allow() Filter?: string;
  @ApiPropertyOptional() @Allow() RowLimit?: string | number;
}

// Settings → Manage Users page of CI3 (Users controller), same method names as its JS calls.
@ApiTags("Users")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "Page data: RolesList, DepartmentList, DesignationList, NextEmpCode, StaffStats, CanSeeSalary, BranchesList, InitStatus" })
  async getPageData(@Query() dto: UsersPageDto) {
    return ciSuccess(await this.users.getPageData(dto.orgId, dto.userId, dto.status, dto.langCode || "en"));
  }

  @Get("getPageDetails/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Staff list page (Data, TotalCount, PageNo, RowLimit, Stats)" })
  async getPageDetails(@Param("pageNo") pageNo: string, @Query() dto: UserListDto) {
    return ciSuccess(await this.users.getPage(dto.orgId, dto.userId, Math.max(1, Number(pageNo) || 1), dto.RowLimit, dto.Filter ?? {}));
  }

  @Get("getUserDetail")
  @ApiOperation({ summary: "A staff member for the edit form (Data with Addresses, Attachments, BranchAccess)" })
  async getUserDetail(@Query() dto: UserQueryDto) {
    return ciSuccess(await this.users.getDetail(dto.orgId, dto.userId, postInt(dto, "UserUID")));
  }

  @Post("saveUser")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create / update a staff member (sends the password-setup email to a new login user)" })
  async saveUser(@Body() dto: UserFormDto, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.users.save({ ...dto }, writeContext(dto, req), sessionKeyOf(req)));
  }

  @Post("toggleStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Activate / deactivate a user (not the Super Admin)" })
  async toggleStatus(@Body() dto: UserStatusDto, @Req() req: Request) {
    return ciSuccess(await this.users.toggleStatus({ ...dto }, writeContext(dto, req)));
  }

  @Post("saveUserAttachment")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("AttachFile")
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Upload a document for a staff member (Attachments)" })
  async saveUserAttachment(@Body() dto: UserAttachmentDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.users.addAttachment(writeContext(dto, req), postInt(dto, "UserUID"), filesOf(files, "AttachFile")[0], dto.DocType));
  }

  @Post("deleteUserAttachment")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a staff document (Attachments)" })
  async deleteUserAttachment(@Body() dto: UserAttachmentIdDto, @Req() req: Request) {
    return ciSuccess(await this.users.deleteAttachment(writeContext(dto, req), postInt(dto, "UserUID"), postInt(dto, "AttachUID")));
  }

  @Post("updateLanguage")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "The caller's UI language (en / ta), also in the session" })
  async updateLanguage(@Body() dto: LanguageDto, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.users.updateLanguage(writeContext(dto, req), String(dto.UILanguage ?? ""), sessionKeyOf(req)));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Get("getEmployeeList")
  @ApiExcludeEndpoint()
  async getEmployeeList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.users.getEmployees(dto.orgId));
  }

  @Get("getOrgUsers")
  @ApiExcludeEndpoint()
  async getOrgUsers(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.users.getLoginUsers(dto.orgId));
  }
}
