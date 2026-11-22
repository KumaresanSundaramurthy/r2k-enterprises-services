import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { RedisService } from "../../common/redis/redis.service";

export interface RenewalContext {
  orgUID: number;
  sid: string;
  redisKey: string;
}

/**
 * Validates the short-lived `rnt_` Redis token passed as `sid` on the public renewal page.
 * Mirrors CI3's Redisservice::envKey() — applies the same S- prefix in non-production envs.
 * Sets req.renewalContext = { orgUID, sid, redisKey } on success.
 */
@Injectable()
export class RenewalTokenGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { renewalContext?: RenewalContext }>();
    const sid = String(req.body?.sid ?? "").trim();

    if (!sid) throw new UnauthorizedException("Session reference is missing.");

    const redisKey = this.redis.envKey(`rnt_${sid}`);
    const data = await this.redis.get<{ orgUID: number }>(redisKey);

    if (!data || !data.orgUID) throw new UnauthorizedException("Renewal session has expired. Please go back to the login page and try again.");

    req.renewalContext = { orgUID: Number(data.orgUID), sid, redisKey };
    return true;
  }
}
