import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { AcceptForm } from "../products/product-files";
import { ClaimsRequest, sessionKeyOf } from "../session-sync/session-sync.service";
import { AssistantService } from "./assistant.service";

export class AssistantChatDto extends OrgUserBranchContextDto {
  @ApiProperty({ description: "The question (at most 600 characters)" }) @Allow() message?: string;
  @ApiPropertyOptional({ description: 'Earlier turns as JSON: [{"role":"user"|"model","text":"..."}] (last 6 are used)' }) @Allow() history?: string;
}

// CI3 Assistant controller (AI Business Assistant widget)
@ApiTags("AI Assistant")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/assistant")
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post("chat")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({
    summary: "Ask the AI assistant about the business: {Error, Message, Reply}",
    description: "Needs EnableAIAssistant = Yes and GEMINI_API_KEY. At most 30 answered questions per login session.",
  })
  async chat(@Body() dto: AssistantChatDto, @Req() req: ClaimsRequest) {
    const caller = { orgUID: dto.orgId, branchUID: dto.branchId, userUID: dto.userId, sessionKey: sessionKeyOf(req) };
    return ciSuccess(await this.assistant.chat(caller, dto.message, dto.history));
  }
}
