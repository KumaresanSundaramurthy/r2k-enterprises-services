import { Injectable, Logger } from "@nestjs/common";
import { Request } from "express";
import { ErpSessionPayload } from "../../auth/interfaces/erp-session.interface";
import { SessionService } from "../../auth/services/session.service";
import { RedisService } from "../../common/redis/redis.service";

// Request after CiJwtGuard: the verified token claims
export type ClaimsRequest = Request & { jwtClaims?: Record<string, unknown> };

// Redis key of the logged-in session, when the Bearer token is a session JWT
export const sessionKeyOf = (req: ClaimsRequest): string | undefined => (typeof req.jwtClaims?.key === "string" ? req.jwtClaims.key : undefined);

/**
 * Keeps the logged-in session (Redis, under the session JWT's `key` claim) in step with changes the user makes,
 * as CI3 does with refreshUserCache and its JwtUserKey patches. Best effort: a token without a session key, or a
 * session that has ended, is skipped and never fails the request.
 */
@Injectable()
export class SessionSyncService {
  private readonly logger = new Logger(SessionSyncService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly sessions: SessionService
  ) {}

  // Globalservice::refreshUserCache — rebuilds the session payload (name, photo, menus, …) from the database
  async refresh(sessionKey: string | undefined): Promise<void> {
    await this.bestEffort("refresh", sessionKey, async (key, data) => {
      await this.sessions.refreshSession({ key, token: "", data });
    });
  }

  // Changes part of the session payload in place, keeping its remaining lifetime
  async patch(sessionKey: string | undefined, change: (data: ErpSessionPayload) => ErpSessionPayload): Promise<void> {
    await this.bestEffort("patch", sessionKey, async (key, data) => {
      const ttl = await this.redis.ttl(key);
      if (ttl > 0) await this.redis.set(key, change(data), ttl);
    });
  }

  private async bestEffort(what: string, key: string | undefined, task: (key: string, data: ErpSessionPayload) => Promise<void>): Promise<void> {
    if (!key) return;
    try {
      const data = await this.redis.get<ErpSessionPayload>(key);
      if (data?.User) await task(key, data);
    } catch (err) {
      this.logger.warn(`Session ${what} skipped: ${(err as Error).message}`);
    }
  }
}
