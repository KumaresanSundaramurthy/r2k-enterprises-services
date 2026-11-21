import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiServerGuard } from "../../common/guards/ci-server.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { SubscriptionCheck, SubscriptionCheckService } from "../services/subscription-check.service";
import { AllPlanModuleRow, PlanModuleRow, PublicPlanRow } from "../repositories/subscription.repository";
import { getRequestMeta } from "../utils/device-info";

class CheckDto {
  @Allow() user_uid!: number;
}

class PlanModulesDto {
  @Allow() plan_uid!: number;
  @Allow() sector_uid!: number;
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

  @Get("public-plans")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Return all active public plans (Launch page pricing)" })
  async publicPlans(): Promise<{ data: PublicPlanRow[] }> {
    return { data: await this.subscriptionCheck.getPublicPlans() };
  }

  @Post("plan-modules")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Return modules included in a given plan+sector combination" })
  async planModules(@Body() dto: PlanModulesDto): Promise<{ data: PlanModuleRow[] }> {
    return { data: await this.subscriptionCheck.getPlanModules(Number(dto.plan_uid), Number(dto.sector_uid)) };
  }

  @Get("all-plan-modules")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Return modules for all plans in one query (Launch page use)" })
  async allPlanModules(): Promise<{ data: AllPlanModuleRow[] }> {
    return { data: await this.subscriptionCheck.getAllPlanModules() };
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
