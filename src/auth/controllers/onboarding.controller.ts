import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ciSuccess } from "../../core/response/ci-response";
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

  // Onboarding::getStates (Global_model::getIndianStates) — CI3's { Error, Data } shape
  @Get("states")
  @ApiOperation({ summary: "Indian states for the onboarding form: {Error, Data: [{name, iso2}]} (the form's value is 'iso2|name')" })
  async getStates() {
    return ciSuccess({ Data: await this.onboardingService.getStates() });
  }

  // Onboarding::getTimezones (Global_model::getTimezoneDetails) — CI3's { Error, Data } shape
  @Get("timezones")
  @ApiOperation({ summary: "Timezones for the onboarding form: {Error, Data: [{TimezoneUID, CountryCode, CountryName, Timezone, GmtOffset, UTCOffset, RawOffset}]}" })
  async getTimezones() {
    return ciSuccess({ Data: await this.onboardingService.getTimezones() });
  }

  @Post("complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Complete the organisation profile after Google signup" })
  complete(@ErpSession() session: ErpSessionContext, @Body() dto: CompleteOnboardingDto) {
    return this.onboardingService.complete(session, dto);
  }
}
