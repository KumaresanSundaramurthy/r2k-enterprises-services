import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { AcceptForm } from "../products/product-files";
import { UserPreferencesService } from "./user-preferences.service";

export class SavePreferenceDto extends OrgUserBranchContextDto {
  @ApiProperty({ example: "df_invoices", description: "At most 100 characters" }) @Allow() PreferenceKey?: string;
  @ApiProperty({ example: "this_month" }) @Allow() PreferenceValue?: string;
}

export class PreferenceKeyDto extends OrgUserBranchContextDto {
  @ApiProperty({ example: "df_invoices" }) @Allow() PreferenceKey?: string;
}

// CI3 Userpreferences controller (and Userpreferences_model); preferences are kept per org, branch and user.
@ApiTags("User Preferences")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/userpreferences")
export class UserPreferencesController {
  constructor(private readonly preferences: UserPreferencesService) {}

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Save one preference (insert or update) and log it to the activity log" })
  async save(@Body() dto: SavePreferenceDto, @Req() req: Request) {
    return ciSuccess(await this.preferences.save(writeContext(dto, req), dto.PreferenceKey, dto.PreferenceValue));
  }

  @Get("getAll")
  @ApiOperation({ summary: "All of the user's preferences in the branch: {Preferences: {key: value}}" })
  async getAll(@Query() dto: OrgUserBranchContextDto) {
    return ciSuccess(await this.preferences.getAll(dto.orgId, dto.branchId, dto.userId));
  }

  // Userpreferences_model::getUserPreference — used by CI3's MY_Controller::getDateFilterPreference
  @Get("getUserPreference")
  @ApiOperation({ summary: "One preference: {PreferenceValue} (null when not saved)" })
  async getUserPreference(@Query() dto: PreferenceKeyDto) {
    return ciSuccess(await this.preferences.get(dto.orgId, dto.branchId, dto.userId, dto.PreferenceKey));
  }
}
