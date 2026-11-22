import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { toInt } from "../../common/utils/php-compat";
import { SignupService } from "../services/signup.service";
import { getRequestMeta } from "../utils/device-info";

/**
 * CI3 Signup::doSignup. CI3 calls it server-to-server with PublicServiceToken (forwarding the visitor's IP and
 * user agent) and copies the session cookies to its own domain, as it does for api/auth/login.
 * Cookies are intentionally NOT set here — CI3 reads token + refreshToken from the JSON body and sets
 * the cookies on its own domain so they work on both localhost and the stage URL.
 */
@ApiTags("Signup")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/signup")
export class CiSignupController {
  constructor(
    private readonly signup: SignupService,
  ) {}

  @Post("doSignup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Register a new organisation with its admin user, then sign in",
    description:
      "Form fields as CI3's signup page posts them (OrgName, BrandName, ShortCode, OrgMobile, OrgEmail, GSTIN, StateCode, " +
      "StateName, TimezoneUID, Addr*, AdminFirstName, AdminLastName, AdminUsername, AdminPassword, ConfirmPassword, " +
      "SectorPlanUID). Returns {Error, Message, IsPaidPlan, nextStep, token, expiresIn, refreshToken}; CI3 sets the cookies.",
  })
  async doSignup(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const result = await this.signup.doSignup(body ?? {}, getRequestMeta(req));
    const { Message, ...safe } = result;
    return ciSuccess(safe, Message);
  }

  @Post("googleAuth")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Google sign-up: sign in an existing account, or create a new organisation from the Google profile",
    description:
      "credential = the Google ID token from the button; SectorPlanUID = plan chosen (0 = none). Returns {Error, Redirect " +
      "(dashboard / subscribe / onboarding), IsPaidPlan, nextStep, token, expiresIn, refreshToken}; CI3 sets the cookies.",
  })
  async googleAuth(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const result = await this.signup.googleAuth(String(body?.credential ?? "").trim(), toInt(body?.SectorPlanUID), getRequestMeta(req));
    return ciSuccess(result);
  }
}
