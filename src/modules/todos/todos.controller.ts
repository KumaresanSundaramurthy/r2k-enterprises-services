import { Controller, Get, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt, postString } from "../../core/utils/form-values";
import { TodosService } from "./todos.service";

export class TodoDetailQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number, description: "TodoUID to fetch" }) @Allow() todoUID?: string | number;
}

export class TodoBadgeQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number, description: "UserUID whose pending badge count is needed" }) @Allow() userId?: string | number;
}

export class LinkedTodosQueryDto extends OrgContextDto {
  @ApiProperty({ description: "RefType (Customer, Invoice, ...)" }) @Allow() refType?: string;
  @ApiProperty({ type: Number, description: "RefUID of the linked entity" }) @Allow() refUID?: string | number;
}

@ApiTags("Todos")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/todos")
export class TodosController {
  constructor(private readonly todos: TodosService) {}

  @Get("getDetail")
  @ApiOperation({ summary: "Single task detail (Todo) by TodoUID" })
  async getDetail(@Query() dto: TodoDetailQueryDto) {
    return ciSuccess(await this.todos.getDetail(dto.orgId, postInt(dto, "todoUID")));
  }

  @Get("getBadgeCount")
  @ApiOperation({ summary: "Pending task badge count for a user (Open + InProgress + OnHold)" })
  async getBadgeCount(@Query() dto: TodoBadgeQueryDto) {
    return ciSuccess(await this.todos.getBadgeCount(dto.orgId, postInt(dto, "userId")));
  }

  @Get("getLinkedTodos")
  @ApiOperation({ summary: "All todos linked to an ERP entity by RefType + RefUID" })
  async getLinkedTodos(@Query() dto: LinkedTodosQueryDto) {
    return ciSuccess(await this.todos.getLinkedTodos(dto.orgId, postString(dto, "refType") ?? "", postInt(dto, "refUID")));
  }
}
