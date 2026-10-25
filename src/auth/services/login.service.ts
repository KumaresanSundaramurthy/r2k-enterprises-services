import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import {
  hashPassword,
  isBcryptHash,
  parseDateTime,
  phpBool,
  resolveCdnUrl,
  toInt,
  verifyPassword,
} from "../../common/utils/php-compat";
import { ErpUserRow } from "../interfaces/erp-user.interface";
import { ErpUserRepository } from "../repositories/erp-user.repository";
import { SecurityRepository } from "../repositories/security.repository";
import { RequestMeta } from "../utils/device-info";
import { AuthTokenService } from "./auth-token.service";
import { SessionService } from "./session.service";
import { SubscriptionCheck, SubscriptionCheckService } from "./subscription-check.service";

export type LoginNextStep = "DASHBOARD" | "SUBSCRIBE" | "RENEW" | "ONBOARDING" | "FORCE_PASSWORD_CHANGE";

export interface LoginResult {
  nextStep: LoginNextStep;
  message?: string;
  token?: string;
  expiresIn?: number;
  renewToken?: string;
  changeToken?: string;
  user?: Record<string, unknown>;
  subscription?: Omit<SubscriptionCheck, "plan">;
}

const STEP_TWO_TTL_SECONDS = 300;
const FORCED_CHANGE_TTL_SECONDS = 900;
const PASSWORD_MAX_AGE_DAYS = 180;
const MAX_FAILURES_PER_IP = 10;
const IP_WINDOW_SECONDS = 900;
const MAX_FAILURES_PER_ACCOUNT = 5;

function formatExpiryDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

// Port of CI3's Login::validateUsername / doLoginForm and Oauth::_completeOAuthLogin.
@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(
    private readonly userRepository: ErpUserRepository,
    private readonly securityRepository: SecurityRepository,
    private readonly redis: RedisService,
    private readonly tokens: AuthTokenService,
    private readonly sessions: SessionService,
    private readonly subscriptions: SubscriptionCheckService
  ) {}

  // Step 1: confirm the account can sign in with a password before the password screen is shown.
  async identify(identifier: string) {
    const user = await this.userRepository.findStepOneUser(identifier.trim());
    if (!user) {
      throw new NotFoundException("User account not found.");
    }
    this.assertCanSignIn({
      isLocked: user.IsLocked,
      authProvider: user.AuthProvider,
      password: user.Password,
      loginExpiry: user.LoginExpiryDateTime,
      orgEmailVerified: user.IsEmailVerified,
      orgEmail: user.OrgEmail,
    });

    const displayName = `${user.FirstName ?? ""} ${user.LastName ?? ""}`.trim() || user.UserName;
    return {
      username: user.UserName,
      displayName,
      imageUrl: resolveCdnUrl(user.Image),
      loginToken: this.tokens.signShortLived({ purpose: "login_step2", uid: toInt(user.UserUID) }, STEP_TWO_TTL_SECONDS),
      loginTokenExpiresIn: STEP_TWO_TTL_SECONDS,
    };
  }

  // Step 2 (or single-step with identifier + password).
  async login(input: { loginToken?: string; identifier?: string; password: string }, meta: RequestMeta): Promise<LoginResult> {
    const ipKey = this.redis.envKey(`login-fail-ip-${meta.ipAddress}`);
    const ipFailures = toInt(await this.redis.get(ipKey));
    if (ipFailures >= MAX_FAILURES_PER_IP) {
      throw new HttpException(
        "Too many failed login attempts from your location. Please try again in 15 minutes.",
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    const isTwoStep = !!input.loginToken;
    const user = await this.findLoginUser(input);
    if (!user) {
      await this.redis.set(ipKey, ipFailures + 1, IP_WINDOW_SECONDS);
      throw new UnauthorizedException("Invalid username or password.");
    }

    if (phpBool(user.IsLocked)) {
      await this.auditFailure(user.UserName, "Account locked", meta);
      throw new ForbiddenException("Account is locked. Contact administrator.");
    }
    this.assertCanSignIn({
      isLocked: user.IsLocked,
      authProvider: user.AuthProvider,
      password: user.UserPassword,
      loginExpiry: user.LoginExpiryDateTime,
      orgEmailVerified: user.OrgIsEmailVerified,
      orgEmail: user.OrgEmail,
    });

    const userUID = toInt(user.UserUID);
    if (!(await verifyPassword(input.password, user.UserPassword))) {
      await this.auditFailure(user.UserName, "Invalid credentials", meta);
      await this.redis.set(ipKey, ipFailures + 1, IP_WINDOW_SECONDS);
      const failures = await this.securityRepository.countRecentFailures(user.UserName).catch(() => 0);
      if (failures >= MAX_FAILURES_PER_ACCOUNT) {
        await this.userRepository.lock(userUID);
        await this.auditFailure(user.UserName, "Account locked - too many attempts", meta);
      }
      throw new UnauthorizedException(isTwoStep ? "Incorrect password. Please try again." : "Invalid username or password.");
    }

    // Password expiry — force a change after 180 days (not for Google accounts)
    const changedOn = parseDateTime(user.PasswordChangedOn);
    if (changedOn && (user.AuthProvider ?? "local") !== "google") {
      const ageDays = (Date.now() - changedOn.getTime()) / (86400 * 1000);
      if (ageDays > PASSWORD_MAX_AGE_DAYS) {
        return {
          nextStep: "FORCE_PASSWORD_CHANGE",
          message: "Your password has expired. Please set a new password to continue.",
          changeToken: this.tokens.signShortLived(
            { purpose: "force_password_change", uid: userUID },
            FORCED_CHANGE_TTL_SECONDS
          ),
        };
      }
    }

    // Lazy migration — upgrade a legacy base64 password to bcrypt on first successful login
    if (!isBcryptHash(user.UserPassword ?? "")) {
      await this.userRepository.update(userUID, { Password: await hashPassword(input.password) });
    }

    const result = await this.completeLogin(user, "WEB", user.UserName, meta);
    await this.redis.del(ipKey);
    return result;
  }

  // Shared by password and social login: subscription check, session creation and next-step routing.
  async completeLogin(user: ErpUserRow, loginType: string, attemptedUsername: string, meta: RequestMeta): Promise<LoginResult> {
    const userUID = toInt(user.UserUID);
    const subscription = await this.subscriptions.check(userUID);
    // Expired orgs are still allowed in so they can renew
    await this.subscriptions.logLoginAttempt(userUID, attemptedUsername, subscription.status, meta);

    const session = await this.sessions.createSession(user, loginType, attemptedUsername, meta);

    let nextStep: LoginNextStep = "DASHBOARD";
    let renewToken: string | undefined;
    if (subscription.status === "PendingPayment") {
      nextStep = user.IsOnboardingComplete !== null && !phpBool(user.IsOnboardingComplete) ? "ONBOARDING" : "SUBSCRIBE";
    } else if (!subscription.isValid) {
      nextStep = "RENEW";
      renewToken = await this.subscriptions.createRenewToken(toInt(user.UserOrgUID));
    }

    const { plan: _plan, ...subscriptionSummary } = subscription;
    return {
      nextStep,
      token: session.token,
      expiresIn: session.expiresIn,
      renewToken,
      user: this.toUserSummary(user),
      subscription: subscriptionSummary,
    };
  }

  // Lockout, Google-only, missing password, portal expiry and org email checks from Login::validateUsername.
  private assertCanSignIn(user: {
    isLocked: string | null;
    authProvider: string | null;
    password: string | null;
    loginExpiry: string | null;
    orgEmailVerified: string | null;
    orgEmail: string | null;
  }): void {
    if (phpBool(user.isLocked)) {
      throw new ForbiddenException("Account is locked. Contact your administrator.");
    }
    if ((user.authProvider ?? "local") === "google") {
      throw new BadRequestException(
        "This account was created with Google. Please use Continue with Google to sign in."
      );
    }
    if (!user.password) {
      throw new BadRequestException("No password has been set for this account. Please use Forgot Password to set one.");
    }
    const expiry = parseDateTime(user.loginExpiry);
    if (expiry && expiry.getTime() < Date.now()) {
      throw new ForbiddenException(
        `Your portal access expired on ${formatExpiryDate(expiry)}. Please contact your administrator.`
      );
    }
    if (!phpBool(user.orgEmailVerified)) {
      throw new ForbiddenException({
        message:
          "Your organisation email address has not been verified. Please check your inbox for the verification link.",
        needsEmailVerification: true,
        orgEmail: (user.orgEmail ?? "").trim().toLowerCase(),
      });
    }
  }

  // Lockout and portal-expiry checks shared with social login (which skips the password and email checks).
  assertSocialSignInAllowed(user: ErpUserRow): void {
    if (phpBool(user.IsLocked)) {
      throw new ForbiddenException("Account is locked. Please contact your administrator.");
    }
    const expiry = parseDateTime(user.LoginExpiryDateTime);
    if (expiry && expiry.getTime() < Date.now()) {
      throw new ForbiddenException(
        `Your portal access expired on ${formatExpiryDate(expiry)}. Please contact your administrator.`
      );
    }
  }

  private async findLoginUser(input: { loginToken?: string; identifier?: string }): Promise<ErpUserRow | null> {
    if (input.loginToken) {
      const claims = this.tokens.verifyShortLived(
        input.loginToken,
        "login_step2",
        "Your sign-in step has expired. Please enter your username again."
      );
      return this.userRepository.findLoginUserByUID(claims.uid ?? 0);
    }
    const identifier = (input.identifier ?? "").trim();
    if (!identifier) {
      throw new BadRequestException("Please enter your username or email.");
    }
    const matches = await this.userRepository.findLoginUsersByIdentifier(identifier);
    return matches.length === 1 ? matches[0] : null;
  }

  private async auditFailure(username: string, reason: string, meta: RequestMeta): Promise<void> {
    await this.securityRepository
      .insertLoginAudit({
        userUID: null,
        orgUID: null,
        branchUID: null,
        status: "FAILED",
        attemptedUsername: username,
        failureReason: reason,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        device: meta.device,
      })
      .catch((err) => this.logger.error(`Login failure audit failed: ${(err as Error).message}`));
  }

  private toUserSummary(user: ErpUserRow): Record<string, unknown> {
    return {
      userUID: toInt(user.UserUID),
      userName: user.UserName,
      firstName: user.UserFirstName,
      lastName: user.UserLastName,
      email: user.UserEmailAddress,
      imageUrl: resolveCdnUrl(user.UserImage),
      roleUID: toInt(user.UserRoleUID),
      roleName: user.UserRoleName,
      orgUID: toInt(user.UserOrgUID),
      orgName: user.UserOrgBrandName || user.UserOrgName || "",
      branchUID: toInt(user.BranchUID),
      branchName: user.BranchName ?? "",
      uiLanguage: user.UILanguage ?? "en",
    };
  }
}
