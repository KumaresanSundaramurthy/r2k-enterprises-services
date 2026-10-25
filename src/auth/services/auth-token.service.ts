import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ErpJwtClaims } from "../interfaces/erp-session.interface";

export type ShortLivedPurpose = "login_step2" | "force_password_change" | "oauth_state";

interface ShortLivedClaims {
  purpose: ShortLivedPurpose;
  uid?: number;
  nonce?: string;
  src?: string;
}

/**
 * Signs the session JWT exactly like CI3's Login_model::setJwtToken (HS256 with JWT_KEY,
 * claims key/iss/iat/nbf/exp) so a token issued by either app is accepted by the other.
 * Short-lived step tokens replace CI3's PHP-session state between login steps.
 */
@Injectable()
export class AuthTokenService {
  constructor(private readonly jwtService: JwtService) {}

  get sessionTtlSeconds(): number {
    return Number(process.env.LOGIN_EXPIRE_SECS) || 7200;
  }

  signSession(redisKey: string): string {
    return this.jwtService.sign(
      { key: redisKey, iss: process.env.HTTP_HOST || "" },
      { expiresIn: this.sessionTtlSeconds, notBefore: 0 }
    );
  }

  verifySession(token: string): ErpJwtClaims {
    const claims = this.jwtService.verify<ErpJwtClaims>(token, { algorithms: ["HS256"] });
    if (!claims.key) {
      throw new UnauthorizedException("Invalid session. Please sign in again.");
    }
    return claims;
  }

  signShortLived(claims: ShortLivedClaims, ttlSeconds: number): string {
    return this.jwtService.sign(claims, { expiresIn: ttlSeconds });
  }

  verifyShortLived(token: string, purpose: ShortLivedPurpose, expiredMessage: string): ShortLivedClaims {
    try {
      const claims = this.jwtService.verify<ShortLivedClaims>(token, { algorithms: ["HS256"] });
      if (claims.purpose !== purpose) throw new Error("Wrong token purpose");
      return claims;
    } catch {
      throw new UnauthorizedException(expiredMessage);
    }
  }
}
