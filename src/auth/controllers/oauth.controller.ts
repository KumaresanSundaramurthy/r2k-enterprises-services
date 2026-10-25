import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Logger, Post, Query, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { FacebookTokenLoginDto, GoogleTokenLoginDto } from "../dto/oauth.dto";
import { LoginResult } from "../services/login.service";
import { OAuthProvider, OAuthService } from "../services/oauth.service";
import { appUrl } from "../utils/app-url";
import { getRequestMeta } from "../utils/device-info";
import { readCookie, setSessionCookie } from "../utils/session-cookie";

const STATE_COOKIE = "r2k_oauth_state";

function nextStepPath(result: LoginResult): string {
  switch (result.nextStep) {
    case "SUBSCRIBE":
      return "subscribe";
    case "ONBOARDING":
      return "onboarding";
    case "RENEW":
      return `subscription/renew?sid=${result.renewToken ?? ""}`;
    default:
      return "dashboard";
  }
}

@ApiTags("Auth — Social sign-in")
@Controller("api/auth")
export class OAuthController {
  private readonly logger = new Logger(OAuthController.name);

  constructor(private readonly oauthService: OAuthService) {}

  @Get("google")
  @ApiOperation({ summary: "Start Google sign-in (browser redirect)" })
  @ApiQuery({ name: "src", required: false, description: "'signup' to show the consent screen" })
  @ApiQuery({ name: "hint", required: false, description: "Email of an account already chosen (login_hint)" })
  googleRedirect(@Query("src") src: string | undefined, @Query("hint") hint: string | undefined, @Res() res: Response) {
    this.startRedirect("google", res, { signup: src === "signup", hint });
  }

  @Get("google/callback")
  @ApiOperation({ summary: "Google redirect target — signs the user in and redirects to the web app" })
  async googleCallback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Query("error") error: string | undefined,
    @Req() req: Request,
    @Res() res: Response
  ) {
    if (error) {
      return this.redirectToLogin(res, error === "access_denied" ? "Google sign-in was cancelled." : `Google returned an error: ${error}`);
    }
    await this.finishRedirect("google", code, state, req, res, (c) => this.oauthService.loginWithGoogleCode(c, getRequestMeta(req)));
  }

  @Post("google")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Google sign-in with an ID token (SPA / mobile)", description: "Returns the same result as password login." })
  async googleToken(@Body() dto: GoogleTokenLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.withSessionCookie(res, await this.oauthService.loginWithGoogleIdToken(dto.idToken, getRequestMeta(req)));
  }

  @Get("facebook")
  @ApiOperation({ summary: "Start Facebook sign-in (browser redirect)" })
  facebookRedirect(@Res() res: Response) {
    this.startRedirect("facebook", res, {});
  }

  @Get("facebook/callback")
  @ApiOperation({ summary: "Facebook redirect target — signs the user in and redirects to the web app" })
  async facebookCallback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Req() req: Request,
    @Res() res: Response
  ) {
    await this.finishRedirect("facebook", code, state, req, res, (c) =>
      this.oauthService.loginWithFacebookCode(c, getRequestMeta(req))
    );
  }

  @Post("facebook")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Facebook sign-in with an access token (SPA / mobile)", description: "Returns the same result as password login." })
  async facebookToken(@Body() dto: FacebookTokenLoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.withSessionCookie(res, await this.oauthService.loginWithFacebookAccessToken(dto.accessToken, getRequestMeta(req)));
  }

  private startRedirect(provider: OAuthProvider, res: Response, options: { signup?: boolean; hint?: string }) {
    try {
      const { url, nonce } = this.oauthService.buildAuthorizationUrl(provider, options);
      res.cookie(STATE_COOKIE, nonce, {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE !== "false",
        sameSite: "lax",
        maxAge: 10 * 60 * 1000,
        path: "/api/auth",
      });
      res.redirect(url);
    } catch (err) {
      this.redirectToLogin(res, err instanceof HttpException ? err.message : "Sign-in is not available right now.");
    }
  }

  private async finishRedirect(
    provider: OAuthProvider,
    code: string | undefined,
    state: string | undefined,
    req: Request,
    res: Response,
    login: (code: string) => Promise<LoginResult>
  ) {
    const nonce = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: "/api/auth" });
    try {
      if (!code) throw new HttpException(`${provider === "google" ? "Google" : "Facebook"} sign-in was cancelled or failed.`, 400);
      this.oauthService.verifyState(state, nonce);
      const result = await login(code);
      this.withSessionCookie(res, result);
      res.redirect(appUrl(nextStepPath(result)));
    } catch (err) {
      if (!(err instanceof HttpException)) this.logger.error(`${provider} sign-in failed: ${(err as Error).message}`);
      this.redirectToLogin(res, err instanceof HttpException ? err.message : "Sign-in failed. Please try again.");
    }
  }

  private withSessionCookie(res: Response, result: LoginResult): LoginResult {
    if (result.token && result.expiresIn) setSessionCookie(res, result.token, result.expiresIn);
    return result;
  }

  private redirectToLogin(res: Response, message: string) {
    res.redirect(appUrl(`login?error=${encodeURIComponent(message)}`));
  }
}
