import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService, TokenExpiredError } from "@nestjs/jwt";
import { Request } from "express";

/**
 * Validates the JWT that the CI3 application sends on every request (Authorization: Bearer <token>).
 * Both apps share JWT_KEY, so this only checks the signature (HS256) and expiry — no session lookup.
 */
@Injectable()
export class CiJwtGuard implements CanActivate {
  private readonly jwt = new JwtService();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { jwtClaims?: Record<string, unknown> }>();
    const header = req.headers.authorization?.trim() ?? "";
    const token = header.replace(/^(bearer\s+)+/i, "").trim();
    if (!token || token === header) {
      throw new UnauthorizedException("Missing token. Send it as 'Authorization: Bearer <token>'.");
    }

    try {
      req.jwtClaims = this.jwt.verify<Record<string, unknown>>(token, { secret: process.env.JWT_KEY, algorithms: ["HS256"] });
    } catch (err) {
      throw new UnauthorizedException(err instanceof TokenExpiredError ? "Token has expired." : "Invalid token.");
    }
    return true;
  }
}
