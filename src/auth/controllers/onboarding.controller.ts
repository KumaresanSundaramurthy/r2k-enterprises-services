import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ErpSession } from "../decorators/erp-session.decorator";
import { CompleteOnboardingDto } from "../dto/onboarding.dto";
import { AllowSessionGates, ErpSessionGuard } from "../guards/erp-session.guard";
import { ErpSessionContext } from "../interfaces/erp-session.interface";
import { OnboardingService } from "../services/onboarding.service";

// Reachable before payment and before onboarding is finished — that is when these are needed.
@ApiTags("Auth — Onboarding")
@ApiBearerAuth()
@Controller("api/auth/onboarding")
@UseGuards(ErpSessionGuard)
@AllowSessionGates("pendingPayment", "onboarding")
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get("states")
  @ApiOperation({ summary: "Indian states for the onboarding form (value is 'iso2|name')" })
  getStates() {
    return this.onboardingService.getStates();
  }

  @Get("timezones")
  @ApiOperation({ summary: "Timezones for the onboarding form" })
  getTimezones() {
    return this.onboardingService.getTimezones();
  }

  @Post("complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Complete the organisation profile after Google signup" })
  complete(@ErpSession() session: ErpSessionContext, @Body() dto: CompleteOnboardingDto) {
    return this.onboardingService.complete(session, dto);
  }
}
