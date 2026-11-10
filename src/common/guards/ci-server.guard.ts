import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService, TokenExpiredError } from "@nestjs/jwt";
import { Request } from "express";

export const CI_SERVER_PURPOSE = "ci-server";
const MAX_LIFETIME_SECS = 300;

/**
 * Server-to-server calls from the CI3 app on pages that have no logged-in user (login, password reset, OAuth, signup).
 * CI3 signs a short-lived token with the shared JWT_KEY: { purpose: "ci-server", iat, exp } (at most 5 minutes).
 * A user's session JWT has no such purpose claim, so it cannot be used here; the token never reaches the browser.
 */
@Injectable()
export class CiServerGuard implements CanActivate {
  private readonly jwt = new JwtService();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization?.trim() ?? "";
    const token = header.replace(/^(bearer\s+)+/i, "").trim();
    if (!token || token === header) {
      throw new UnauthorizedException("Missing token. Send it as 'Authorization: Bearer <token>'.");
    }

    let claims: { purpose?: unknown; iat?: unknown; exp?: unknown };
    try {
      claims = this.jwt.verify(token, { secret: process.env.JWT_KEY, algorithms: ["HS256"] });
    } catch (err) {
      throw new UnauthorizedException(err instanceof TokenExpiredError ? "Token has expired." : "Invalid token.");
    }

    const iat = Number(claims.iat);
    const exp = Number(claims.exp);
    if (claims.purpose !== CI_SERVER_PURPOSE || !iat || !exp || exp - iat > MAX_LIFETIME_SECS) {
      throw new UnauthorizedException("Invalid token.");
    }
    return true;
  }
}
