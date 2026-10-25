import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { TokenExpiredError } from "@nestjs/jwt";
import { RedisService } from "../../common/redis/redis.service";
import { parseDateTime, toInt } from "../../common/utils/php-compat";
import { ErpSessionContext, ErpSessionPayload } from "../interfaces/erp-session.interface";
import { ErpUserRepository } from "../repositories/erp-user.repository";
import { AuthTokenService } from "../services/auth-token.service";
import { readSessionToken } from "../utils/session-cookie";

export type SessionGate = "expiredSubscription" | "pendingPayment" | "onboarding";

const ALLOWED_GATES_KEY = "erpAllowedSessionGates";

// Lets a route through specific CI3 middleware gates (e.g. onboarding must work before payment).
export const AllowSessionGates = (...gates: SessionGate[]) => SetMetadata(ALLOWED_GATES_KEY, gates);

export type ErpRequest = Request & { erpSession?: ErpSessionContext };

const sessionExpired = (message = "Your session has expired. Please sign in to continue.") =>
  new UnauthorizedException({ message, sessionExpired: true });

/**
 * Port of CI3's Middleware::validateJWT: JWT → Redis session → single-session check →
 * subscription / payment / onboarding gates. Accepts sessions created by either app.
 */
@Injectable()
export class ErpSessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AuthTokenService,
    private readonly redis: RedisService,
    private readonly userRepository: ErpUserRepository
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ErpRequest>();
    const token = readSessionToken(req);
    if (!token) throw sessionExpired();

    let key: string;
    try {
      key = this.tokens.verifySession(token).key;
    } catch (err) {
      if (err instanceof TokenExpiredError) throw sessionExpired();
      throw sessionExpired("Invalid session. Please sign in again.");
    }

    const data = await this.redis.get<ErpSessionPayload>(key);
    if (!data || !data.User) throw sessionExpired();

    await this.assertActiveSession(key, data);

    const allowed = this.reflector.getAllAndOverride<SessionGate[]>(ALLOWED_GATES_KEY, [context.getHandler(), context.getClass()]) ?? [];
    this.assertGates(data, allowed);

    req.erpSession = { key, token, data };
    return true;
  }

  // A newer login elsewhere replaces UserActiveSession_{uid}; older sessions are terminated.
  private async assertActiveSession(key: string, data: ErpSessionPayload): Promise<void> {
    const storedToken = data.User.SessionToken;
    const userUID = toInt(data.User.UserUID);
    if (!storedToken || !userUID) return;

    let activeToken = await this.redis.get<string>(this.redis.envKey(`UserActiveSession_${userUID}`));
    if (activeToken === null) {
      activeToken = await this.userRepository.getCurrentSessionToken(userUID);
    }
    if (activeToken !== storedToken) {
      await this.redis.del(key);
      throw sessionExpired(
        "Your session has been terminated because your account was logged in from another device or browser."
      );
    }
  }

  private assertGates(data: ErpSessionPayload, allowed: SessionGate[]): void {
    const sub = data.Subscription;
    if (!sub) return;

    const end = parseDateTime(sub.EndDate);
    const graceEnd = end ? end.getTime() + toInt(sub.GracePeriodDays ?? 7) * 86400 * 1000 : 0;
    const isExpired = (end !== null && Date.now() > graceEnd) || ["Expired", "Cancelled", "Suspended"].includes(sub.Status ?? "");
    if (isExpired && !allowed.includes("expiredSubscription")) {
      throw new HttpException(
        { message: "Your subscription has expired. Please renew your plan to continue.", subscriptionExpired: true },
        HttpStatus.PAYMENT_REQUIRED
      );
    }

    if (sub.Status !== "PendingPayment") return;
    // Onboarding applies only while payment is pending (initial signup state)
    if (toInt(data.Org?.IsOnboardingComplete ?? 1) === 0 && !allowed.includes("onboarding")) {
      throw new ForbiddenException({ message: "Please complete your organisation setup first.", onboardingRequired: true });
    }
    if (!allowed.includes("pendingPayment")) {
      throw new HttpException(
        { message: "Please complete your subscription payment to continue.", paymentPending: true },
        HttpStatus.PAYMENT_REQUIRED
      );
    }
  }
}
