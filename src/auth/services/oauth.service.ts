import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { ErpUserRepository } from "../repositories/erp-user.repository";
import { RequestMeta } from "../utils/device-info";
import { apiUrl } from "../utils/app-url";
import { AuthTokenService } from "./auth-token.service";
import { LoginResult, LoginService } from "./login.service";

export type OAuthProvider = "google" | "facebook";

const STATE_TTL_SECONDS = 600;
const FACEBOOK_GRAPH = "https://graph.facebook.com/v18.0";

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Google and Facebook sign-in (CI3 Oauth controller). Two ways in:
 *  - browser redirect flow: /api/auth/{provider} → provider → /api/auth/{provider}/callback
 *  - token flow for SPAs/mobile: the client signs in with the provider SDK and posts the token here.
 * Both end in LoginService.completeLogin, so the session is identical to a password login.
 */
@Injectable()
export class OAuthService {
  constructor(
    private readonly userRepository: ErpUserRepository,
    private readonly loginService: LoginService,
    private readonly tokens: AuthTokenService
  ) {}

  callbackUrl(provider: OAuthProvider): string {
    return apiUrl(`api/auth/${provider}/callback`);
  }

  // Returns the provider URL to redirect to, plus the nonce the controller binds to a cookie (CSRF protection).
  buildAuthorizationUrl(provider: OAuthProvider, options: { signup?: boolean; hint?: string }): { url: string; nonce: string } {
    const nonce = randomBytes(16).toString("hex");
    const state = this.tokens.signShortLived(
      { purpose: "oauth_state", nonce, src: options.signup ? "signup" : "login" },
      STATE_TTL_SECONDS
    );

    if (provider === "google") {
      const clientId = this.requireEnv("GOOGLE_CLIENT_ID", "Google");
      const hint = (options.hint ?? "").trim();
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: this.callbackUrl("google"),
        response_type: "code",
        scope: "openid email profile",
        state,
        access_type: "online",
        // hint present = account already chosen via FedCM popup; skip the chooser
        prompt: options.signup ? (hint ? "consent" : "select_account consent") : "select_account",
      });
      if (hint) params.set("login_hint", hint);
      return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, nonce };
    }

    const appId = this.requireEnv("FACEBOOK_APP_ID", "Facebook");
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: this.callbackUrl("facebook"),
      scope: "public_profile,email",
      state,
      response_type: "code",
    });
    return { url: `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`, nonce };
  }

  verifyState(state: string | undefined, cookieNonce: string | undefined): void {
    const claims = this.tokens.verifyShortLived(
      state ?? "",
      "oauth_state",
      "Security check failed (state mismatch). Please try again."
    );
    if (!cookieNonce || claims.nonce !== cookieNonce) {
      throw new UnauthorizedException("Security check failed (state mismatch). Please try again.");
    }
  }

  async loginWithGoogleCode(code: string, meta: RequestMeta): Promise<LoginResult> {
    const tokenData = await fetchJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.requireEnv("GOOGLE_CLIENT_ID", "Google"),
        client_secret: this.requireEnv("GOOGLE_CLIENT_SECRET", "Google"),
        redirect_uri: this.callbackUrl("google"),
        grant_type: "authorization_code",
      }).toString(),
    });
    if (typeof tokenData.access_token !== "string") {
      throw new UnauthorizedException("Google did not return an access token. Please try again.");
    }
    const profile = await fetchJson("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    return this.loginWithGoogleProfile(profile, meta);
  }

  // Token flow: verifies a Google ID token (Google Identity Services / mobile SDK).
  async loginWithGoogleIdToken(idToken: string, meta: RequestMeta): Promise<LoginResult> {
    const clientId = this.requireEnv("GOOGLE_CLIENT_ID", "Google");
    const claims = await fetchJson(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (claims.aud !== clientId) {
      throw new UnauthorizedException("Invalid Google token. Please try again.");
    }
    return this.loginWithGoogleProfile(claims, meta);
  }

  async loginWithFacebookCode(code: string, meta: RequestMeta): Promise<LoginResult> {
    const params = new URLSearchParams({
      client_id: this.requireEnv("FACEBOOK_APP_ID", "Facebook"),
      client_secret: this.requireEnv("FACEBOOK_APP_SECRET", "Facebook"),
      redirect_uri: this.callbackUrl("facebook"),
      code,
    });
    const tokenData = await fetchJson(`${FACEBOOK_GRAPH}/oauth/access_token?${params.toString()}`);
    if (typeof tokenData.access_token !== "string") {
      throw new UnauthorizedException("Unable to authenticate with Facebook. Please try again.");
    }
    return this.loginWithFacebookAccessToken(tokenData.access_token, meta, false);
  }

  // Token flow: verifies a Facebook user access token was issued to this app before trusting it.
  async loginWithFacebookAccessToken(accessToken: string, meta: RequestMeta, verifyApp = true): Promise<LoginResult> {
    const appId = this.requireEnv("FACEBOOK_APP_ID", "Facebook");
    if (verifyApp) {
      const appToken = `${appId}|${this.requireEnv("FACEBOOK_APP_SECRET", "Facebook")}`;
      const debug = await fetchJson(
        `${FACEBOOK_GRAPH}/debug_token?${new URLSearchParams({ input_token: accessToken, access_token: appToken }).toString()}`
      );
      const data = (debug.data ?? {}) as Record<string, unknown>;
      if (data.is_valid !== true || String(data.app_id) !== appId) {
        throw new UnauthorizedException("Invalid Facebook token. Please try again.");
      }
    }
    const profile = await fetchJson(
      `${FACEBOOK_GRAPH}/me?${new URLSearchParams({ fields: "id,name,email", access_token: accessToken }).toString()}`
    );
    if (typeof profile.email !== "string" || !profile.email) {
      throw new BadRequestException(
        "Could not retrieve your email from Facebook. Make sure your Facebook account has a verified email address."
      );
    }
    return this.completeSocialLogin(profile.email, "FACEBOOK", meta);
  }

  private async loginWithGoogleProfile(profile: Record<string, unknown>, meta: RequestMeta): Promise<LoginResult> {
    if (typeof profile.email !== "string" || !profile.email) {
      throw new BadRequestException("Google did not return an email address. Please try again.");
    }
    if (profile.email_verified !== true && profile.email_verified !== "true") {
      throw new BadRequestException("Your Google email address is not verified. Please verify it and try again.");
    }
    return this.completeSocialLogin(profile.email, "GOOGLE", meta);
  }

  // Oauth::_completeOAuthLogin. The provider has verified the email, so the org email check is skipped.
  private async completeSocialLogin(email: string, provider: "GOOGLE" | "FACEBOOK", meta: RequestMeta): Promise<LoginResult> {
    const matches = await this.userRepository.findLoginUsersByIdentifier(email);
    if (matches.length !== 1) {
      // CI3 creates a new organisation here for Google; signup is not part of this API yet.
      throw new NotFoundException(`No account found for ${email}. Please sign up first or contact your administrator.`);
    }
    const user = matches[0];
    this.loginService.assertSocialSignInAllowed(user);
    return this.loginService.completeLogin(user, provider, email, meta);
  }

  private requireEnv(name: string, providerLabel: string): string {
    const value = process.env[name];
    if (!value) {
      throw new ServiceUnavailableException(`${providerLabel} sign-in is not configured.`);
    }
    return value;
  }
}
