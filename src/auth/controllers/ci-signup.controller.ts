import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { toInt } from "../../common/utils/php-compat";
import { SignupService } from "../services/signup.service";
import { AuthTokenService } from "../services/auth-token.service";
import { getRequestMeta } from "../utils/device-info";
import { setRefreshCookie, setSessionCookie } from "../utils/session-cookie";

/**
 * CI3 Signup::doSignup. CI3 calls it server-to-server with PublicServiceToken (forwarding the visitor's IP and
 * user agent) and copies the session cookies to its own domain, as it does for api/auth/login.
 */
@ApiTags("Signup")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/signup")
export class CiSignupController {
  constructor(
    private readonly signup: SignupService,
    private readonly tokens: AuthTokenService
  ) {}

  @Post("doSignup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Register a new organisation with its admin user, then sign in",
    description:
      "Form fields as CI3's signup page posts them (OrgName, BrandName, ShortCode, OrgMobile, OrgEmail, GSTIN, StateCode, " +
      "StateName, TimezoneUID, Addr*, AdminFirstName, AdminLastName, AdminUsername, AdminPassword, ConfirmPassword, " +
      "SectorPlanUID). Returns {Error, Message, IsPaidPlan, nextStep, token, expiresIn}; the session and refresh cookies are set.",
  })
  async doSignup(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.signup.doSignup(body ?? {}, getRequestMeta(req));
    if (result.token && result.expiresIn) setSessionCookie(res, result.token, result.expiresIn);
    if (result.refreshToken) setRefreshCookie(res, result.refreshToken, this.tokens.sessionTtlSeconds);
    const { refreshToken: _rt, Message, ...safe } = result;
    return ciSuccess(safe, Message);
  }

  @Post("googleAuth")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Google sign-up: sign in an existing account, or create a new organisation from the Google profile",
    description:
      "credential = the Google ID token from the button; SectorPlanUID = plan chosen (0 = none). Returns {Error, Redirect " +
      "(dashboard / subscribe / onboarding), IsPaidPlan, nextStep, token, expiresIn}; the session and refresh cookies are set.",
  })
  async googleAuth(@Body() body: Record<string, unknown>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.signup.googleAuth(String(body?.credential ?? "").trim(), toInt(body?.SectorPlanUID), getRequestMeta(req));
    if (result.token && result.expiresIn) setSessionCookie(res, result.token, result.expiresIn);
    if (result.refreshToken) setRefreshCookie(res, result.refreshToken, this.tokens.sessionTtlSeconds);
    const { refreshToken: _rt, ...safe } = result;
    return ciSuccess(safe);
  }
}
