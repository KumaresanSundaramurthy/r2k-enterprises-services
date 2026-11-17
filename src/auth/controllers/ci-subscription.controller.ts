import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiServerGuard } from "../../common/guards/ci-server.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { SubscriptionCheck, SubscriptionCheckService } from "../services/subscription-check.service";
import { getRequestMeta } from "../utils/device-info";

class CheckDto {
  @Allow() user_uid!: number;
}

class LogLoginAttemptDto {
  @Allow() user_uid!: number;
  @Allow() username!: string;
  @Allow() subscription_status!: string;
}

/* CI3 server-to-server endpoints for login-time subscription checks (CiServerGuard). */
@ApiTags("Subscription (CI3 server)")
@ApiBearerAuth()
@Controller("api/subscription")
@UseGuards(CiServerGuard)
@UseFilters(CiExceptionFilter)
export class CiSubscriptionController {
  constructor(private readonly subscriptionCheck: SubscriptionCheckService) {}

  @Post("check")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Subscription::checkSubscription — login-time validity check" })
  async check(@Body() dto: CheckDto): Promise<SubscriptionCheck> {
    return this.subscriptionCheck.check(Number(dto.user_uid));
  }

  @Post("log-login-attempt")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Subscription::logLoginAttempt — write LoginAttemptLogTbl row" })
  async logLoginAttempt(@Body() dto: LogLoginAttemptDto, @Req() req: Request): Promise<{ ok: boolean }> {
    const meta = getRequestMeta(req);
    await this.subscriptionCheck.logLoginAttempt(Number(dto.user_uid), dto.username, dto.subscription_status ?? "", meta);
    return { ok: true };
  }
}
