import { Controller, Get, Param, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Allow, IsOptional } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgPagedListDto } from "../../core/dto/org-context.dto";
import { toJsonObject } from "../../core/dto/transforms";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { ActivityLogService } from "./activity-log.service";

class AuditFilterDto {
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateFrom?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateTo?: string;
  @ApiPropertyOptional() @Allow() Module?: string;
  @ApiPropertyOptional() @Allow() Action?: string;
  @ApiPropertyOptional() @Allow() UserUID?: string | number;
  @ApiPropertyOptional() @Allow() EntityType?: string;
  @ApiPropertyOptional({ description: "Matches reference, summary, user name or action" }) @Allow() Search?: string;
}

export class AuditListDto extends OrgPagedListDto {
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { DateFrom, DateTo, Module, Action, UserUID, EntityType, Search }" })
  @IsOptional()
  @Transform(toJsonObject(AuditFilterDto))
  Filter?: AuditFilterDto;
}

export class EntityHistoryDto extends OrgContextDto {
  @ApiProperty({ example: "Product" }) @Allow() EntityType?: string;
  @ApiProperty({ type: Number }) @Allow() EntityUID?: string | number;
}

// Settings → Activity Logs page of CI3 (Activitylog controller), same method names as its JS calls.
@ApiTags("Activity Logs")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/activitylog")
export class ActivityLogController {
  constructor(private readonly activity: ActivityLogService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "Page data: Modules, OrgUsers and the user's saved date range (SavedDateRange/Label/From/To, InitFilter)" })
  async getPageData(@Query() dto: OrgUserBranchContextDto) {
    return ciSuccess(await this.activity.getPageData(dto.orgId, dto.branchId, dto.userId));
  }

  @Get("getPageDetails/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Audit list page, newest first (Data, TotalCount, PageNo, RowLimit)" })
  async getPageDetails(@Param("pageNo") pageNo: string, @Query() dto: AuditListDto) {
    return ciSuccess(await this.activity.getPage(dto.orgId, Math.max(1, Number(pageNo) || 1), dto.RowLimit, dto.Filter ?? {}));
  }

  @Get("getEntityHistory")
  @ApiOperation({ summary: "Last 50 audit entries of one record (History)" })
  async getEntityHistory(@Query() dto: EntityHistoryDto) {
    return ciSuccess(await this.activity.getEntityHistory(dto.orgId, String(dto.EntityType ?? ""), postInt(dto, "EntityUID")));
  }
}
