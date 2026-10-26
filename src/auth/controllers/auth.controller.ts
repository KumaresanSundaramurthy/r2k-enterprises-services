import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { ErpSession } from "../decorators/erp-session.decorator";
import { IdentifyDto, LoginDto } from "../dto/login.dto";
import { ErpSessionGuard } from "../guards/erp-session.guard";
import { ErpSessionContext } from "../interfaces/erp-session.interface";
import { AuthTokenService } from "../services/auth-token.service";
import { LoginService } from "../services/login.service";
import { SessionService } from "../services/session.service";
import { getRequestMeta } from "../utils/device-info";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "../utils/session-cookie";

@ApiTags("Auth")
@Controller("api/auth")
export class AuthController {
  constructor(
    private readonly loginService: LoginService,
    private readonly sessionService: SessionService,
    private readonly tokens: AuthTokenService
  ) {}

  @Post("login/identify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Login step 1 — check a username or email",
    description:
      "Validates that the account exists and can sign in (not locked, not Google-only, password set, portal access " +
      "not expired, organisation email verified). Returns the display name and a 5-minute loginToken for step 2.",
  })
  identify(@Body() dto: IdentifyDto) {
    return this.loginService.identify(dto.identifier);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Login step 2 — password",
    description:
      "Send loginToken (from step 1) or identifier, plus password. On success returns the session token (also set as " +
      "the shared session cookie) and nextStep: DASHBOARD, SUBSCRIBE, RENEW (with renewToken) or ONBOARDING. If the " +
      "password is older than 180 days, nextStep is FORCE_PASSWORD_CHANGE with a changeToken and no session.",
  })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.loginService.login(dto, getRequestMeta(req));
    if (result.token && result.expiresIn) {
      setSessionCookie(res, result.token, result.expiresIn);
    }
    return result;
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Log out — ends the session and clears its caches" })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = readSessionToken(req);
    if (token) {
      try {
        const { key } = this.tokens.verifySession(token);
        await this.sessionService.destroySession(key);
      } catch {
        // An expired or invalid token on logout is normal — just clear the cookie
      }
    }
    clearSessionCookie(res);
    return { message: "Logged out." };
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ErpSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Refresh menus, permissions and session data",
    description: "Re-reads the role's menus and permissions and the user/org details after an admin changes them.",
  })
  async refresh(@ErpSession() session: ErpSessionContext) {
    await this.sessionService.refreshSession(session);
    return { message: "Cache refreshed successfully. Changes will reflect on next page load." };
  }
}
