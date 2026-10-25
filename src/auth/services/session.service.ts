import { Injectable, Logger } from "@nestjs/common";
import { randomBytes, randomUUID } from "crypto";
import { RedisService } from "../../common/redis/redis.service";
import { UpstashService } from "../../common/redis/upstash.service";
import { nowDateTime, parseDateTime, toInt } from "../../common/utils/php-compat";
import { ErpUserRow } from "../interfaces/erp-user.interface";
import { ErpSessionContext, ErpSessionPayload } from "../interfaces/erp-session.interface";
import { DbRow, SessionDataRepository } from "../repositories/session-data.repository";
import { ErpUserRepository } from "../repositories/erp-user.repository";
import { SecurityRepository } from "../repositories/security.repository";
import { RequestMeta } from "../utils/device-info";
import { AuthTokenService } from "./auth-token.service";

interface BuiltSession {
  payload: ErpSessionPayload;
  menus: DbRow[];
  subMenus: DbRow[];
  modules: DbRow[];
  permissions: Record<string, { CanView: number; CanCreate: number; CanEdit: number; CanDelete: number }>;
}

export interface CreatedSession {
  token: string;
  expiresIn: number;
  redisKey: string;
}

const USER_CACHE_TYPES = ["menus", "submenus", "modules", "permissions", "settings", "userinfo"];

/**
 * Builds and stores ERP sessions in the same Redis layout as CI3 (Login_model + Redisservice),
 * so a user logged in through this API is also logged in on the CI3 app and vice versa.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly upstash: UpstashService,
    private readonly sessionData: SessionDataRepository,
    private readonly userRepository: ErpUserRepository,
    private readonly securityRepository: SecurityRepository,
    private readonly tokens: AuthTokenService
  ) {}

  async createSession(user: ErpUserRow, loginType: string, attemptedUsername: string, meta: RequestMeta): Promise<CreatedSession> {
    const built = await this.buildSession(user);
    const userUID = toInt(user.UserUID);
    const orgToken = user.OrgToken ?? "";
    const ttl = this.tokens.sessionTtlSeconds;

    const auditId = await this.securityRepository
      .insertLoginAudit({
        userUID,
        orgUID: toInt(user.UserOrgUID) || null,
        branchUID: toInt(user.BranchUID) || null,
        status: "SUCCESS",
        loginType,
        attemptedUsername,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        device: meta.device,
      })
      .catch((err) => {
        this.logger.error(`Login audit insert failed: ${(err as Error).message}`);
        return null;
      });

    // Single-session token — a newer login overwrites UserActiveSession_{uid}, ending older sessions.
    const sessionToken = randomBytes(32).toString("hex");
    built.payload.User.auditId = auditId ?? 0;
    built.payload.User.SessionToken = sessionToken;

    const redisKey = `${randomUUID()}-${userUID}`;
    await this.redis.set(redisKey, built.payload, ttl);

    const { device } = meta;
    const deviceLabel = `${device.browser} / ${device.os} (${device.deviceType})`;
    const now = nowDateTime();
    await this.userRepository.update(userUID, {
      LastLogin: now,
      CurrentSessionToken: sessionToken,
      LastLoginOn: now,
      LastLoginIP: meta.ipAddress,
      LastLoginDevice: loginType === "WEB" ? deviceLabel : `${loginType} / ${deviceLabel}`,
    });

    await this.redis.set(this.redis.envKey(`UserActiveSession_${userUID}`), sessionToken, ttl);
    await this.writeUserCaches(userUID, orgToken, built, user, ttl);

    return { token: this.tokens.signSession(redisKey), expiresIn: ttl, redisKey };
  }

  // Auth::refreshTokens + Globalservice::refreshUserCache — re-reads role menus, permissions and the session payload.
  async refreshSession(session: ErpSessionContext): Promise<void> {
    const userUID = toInt(session.data.User.UserUID);
    const roleUID = toInt(session.data.User.RoleUID);
    const orgToken = String(session.data.Org.OrgToken ?? "");

    await this.redis.del(
      this.redis.orgKey(`role-menus-${roleUID}`, orgToken),
      this.redis.orgKey(`role-submenus-${roleUID}`, orgToken),
      this.redis.globalKey("global-modules")
    );

    const user = await this.userRepository.findLoginUserByUID(userUID);
    if (!user) return;

    const built = await this.buildSession(user);
    const remainingTtl = await this.redis.ttl(session.key);
    const ttl = remainingTtl > 0 ? remainingTtl : this.tokens.sessionTtlSeconds;

    // Keep the single-session token and audit id so the refresh does not end the session.
    built.payload.User.SessionToken = session.data.User.SessionToken;
    built.payload.User.auditId = session.data.User.auditId ?? 0;
    await this.redis.set(session.key, built.payload, ttl);
    await this.writeUserCaches(userUID, orgToken, built, user, ttl);
    await this.redis.del(this.redis.orgKey("org-info", orgToken));
  }

  // Login::logout — closes the audit row, revokes the single-session token and clears user/org caches.
  async destroySession(redisKey: string): Promise<void> {
    const data = await this.redis.get<ErpSessionPayload>(redisKey);
    if (data?.User) {
      const auditId = toInt(data.User.auditId);
      if (auditId > 0) {
        await this.securityRepository.closeLoginAudit(auditId).catch(() => undefined);
      }

      const userUID = toInt(data.User.UserUID);
      const orgToken = String(data.Org?.OrgToken ?? data.User.OrgToken ?? "");
      if (userUID > 0) {
        await this.revokeActiveSession(userUID);
        await this.redis.del(...USER_CACHE_TYPES.map((type) => this.redis.userKey(type, userUID, orgToken)));
      }

      const roleUID = toInt(data.User.RoleUID);
      if (roleUID > 0) {
        await this.redis.del(
          this.redis.orgKey(`role-menus-${roleUID}`, orgToken),
          this.redis.orgKey(`role-submenus-${roleUID}`, orgToken)
        );
      }
      await this.redis.del(
        this.redis.globalKey("global-modules"),
        this.redis.globalKey("global-attach-cfg"),
        this.redis.orgKey("org-users", orgToken)
      );
    }
    await this.redis.del(redisKey);
  }

  // Ends whatever session the user currently has (after a password change or reset).
  async revokeActiveSession(userUID: number): Promise<void> {
    await this.redis.del(this.redis.envKey(`UserActiveSession_${userUID}`));
    await this.userRepository.clearSessionToken(userUID);
  }

  private async writeUserCaches(userUID: number, orgToken: string, built: BuiltSession, user: ErpUserRow, ttl: number) {
    // The cached user row omits the password hash and the verification columns only this API selects.
    const { UserPassword: _password, OrgIsEmailVerified: _verified, OrgEmail: _orgEmail, ...userInfo } = user;
    await this.redis.set(this.redis.userKey("menus", userUID, orgToken), built.menus, ttl);
    await this.redis.set(this.redis.userKey("submenus", userUID, orgToken), built.subMenus, ttl);
    await this.redis.set(this.redis.userKey("modules", userUID, orgToken), built.modules, ttl);
    await this.redis.set(this.redis.userKey("permissions", userUID, orgToken), built.permissions, ttl);
    await this.redis.set(this.redis.userKey("userinfo", userUID, orgToken), userInfo, ttl);
  }

  // Port of Login_model::formatJWTPayload. Menus, sub-menus and modules are cached separately, not in the payload.
  private async buildSession(user: ErpUserRow): Promise<BuiltSession> {
    const userUID = toInt(user.UserUID);
    const orgUID = toInt(user.UserOrgUID);
    const roleUID = toInt(user.UserRoleUID);
    const orgToken = user.OrgToken ?? "";
    const ttl = this.tokens.sessionTtlSeconds;

    const [menus, subMenus, modules, genSettings, prodSettings, transSettings, attachCfg, branches, subscription, orgTimezone, signatures] =
      await Promise.all([
        this.cached(this.redis.orgKey(`role-menus-${roleUID}`, orgToken), ttl, () =>
          this.sessionData.getRoleMainMenus(roleUID, orgUID)
        ),
        this.cached(this.redis.orgKey(`role-submenus-${roleUID}`, orgToken), ttl, () =>
          this.sessionData.getRoleSubMenus(roleUID, orgUID)
        ),
        this.cached(this.redis.globalKey("global-modules"), 86400, () => this.sessionData.getModules()),
        this.sessionData.getOrgGeneralSettings(orgUID),
        this.sessionData.getProductSettings(orgUID).catch(() => null),
        this.loadTransactionSettings(orgUID),
        this.loadAttachmentConfig(),
        this.sessionData.getAccessibleBranches(userUID, orgUID).catch(() => []),
        this.loadOrgSubscription(orgUID),
        this.sessionData.getOrgTimezone(orgUID).catch(() => null),
        this.loadSignatures(userUID, orgUID),
      ]);

    const permissions: BuiltSession["permissions"] = {};
    for (const subMenu of subMenus) {
      if (subMenu.ControllerName) {
        permissions[subMenu.ControllerName] = {
          CanView: toInt(subMenu.CanView),
          CanCreate: toInt(subMenu.CanCreate),
          CanEdit: toInt(subMenu.CanEdit),
          CanDelete: toInt(subMenu.CanDelete),
        };
      }
    }

    const payload: ErpSessionPayload = {
      User: {
        UserUID: user.UserUID,
        FirstName: user.UserFirstName,
        LastName: user.UserLastName,
        UserName: user.UserName,
        EmailAddress: user.UserEmailAddress,
        UserImage: user.UserImage,
        RoleUID: user.UserRoleUID,
        RoleName: user.UserRoleName,
        Timezone: user.Timezone,
        Signatures: signatures,
        OrgShortCode: user.OrgShortCode ?? "",
        OrgToken: orgToken,
        UILanguage: user.UILanguage ?? "en",
        LastLoginOn: user.LastLoginOn ?? null,
        LastLoginDevice: user.LastLoginDevice ?? null,
      },
      Org: {
        OrgUID: user.UserOrgUID ?? "",
        BranchUID: user.BranchUID,
        BranchName: user.BranchName ?? "",
        BranchCode: user.BranchCode ?? "",
        OrgCCode: user.UserOrgCCode,
        OrgCISO2: user.UserOrgCISO2,
        OrgLogo: user.UserOrgLogo,
        OrgName: user.UserOrgBrandName || user.UserOrgName || "",
        OrgMobile: user.UserOrgMobile ?? "",
        OrgShortCode: user.OrgShortCode ?? "",
        OrgToken: orgToken,
        StateCode: user.OrgStateCode ?? "",
        StateName: user.OrgStateName ?? "",
        SectorUID: user.SectorUID === null ? 1 : toInt(user.SectorUID),
        IsOnboardingComplete: user.IsOnboardingComplete === null ? 1 : toInt(user.IsOnboardingComplete),
        OrgTimezone: orgTimezone ?? "UTC",
        AccessibleBranches: branches,
      },
      Permissions: permissions,
      GenSettings: genSettings,
      ProdSettings: prodSettings ?? {},
      TransSettings: transSettings,
      AttachCfg: attachCfg,
      Subscription: subscription,
    };

    const priceListCount = await this.sessionData.countActivePriceLists(orgUID).catch(() => null);
    if (priceListCount !== null) {
      await this.upstash.set(this.redis.orgKey("has-price-lists", orgToken), priceListCount > 0, 0);
    }

    return { payload, menus, subMenus, modules, permissions };
  }

  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = await this.redis.get<T>(key);
    if (hit !== null) return hit;
    const value = await load();
    await this.redis.set(key, value, ttl);
    return value;
  }

  private async loadTransactionSettings(orgUID: number): Promise<Record<string, unknown>> {
    const row: Record<string, unknown> = (await this.sessionData.getTransactionSettings(orgUID).catch(() => null)) ?? {};
    const defaults: Record<string, unknown> = {
      InvoiceCancelAction: "ask",
      SalesReturnCancelAction: "ask",
      SalesReturnItemMethod: "Manual",
      TermsAndConditions: "",
      HideNavOnTransForm: 0,
      ShowProductDescription: 1,
      MaxAdditionalCharges: 5,
      ComboPriceDistribution: "ratio",
      BelowPurchasePriceAction: "warn",
      DefaultTransactionType: "regular",
      AutoDraftSave: 1,
      AutoUpdatePurchasePrice: "off",
    };
    for (const [column, value] of Object.entries(defaults)) {
      if (row[column] === undefined || row[column] === null) row[column] = value;
    }
    return row;
  }

  private async loadAttachmentConfig(): Promise<Record<string, unknown>> {
    return this.cached(this.redis.globalKey("global-attach-cfg"), 86400, async () => {
      const rows = await this.sessionData.getAttachmentSlotConfig().catch(() => []);
      const config: Record<string, unknown> = {};
      for (const row of rows) {
        config[String(row.SlotKey)] = {
          IsEnabled: toInt(row.IsEnabled) !== 0,
          MaxFiles: toInt(row.MaxFiles),
          MaxFileSizeMB: Number(row.MaxFileSizeMB) || 0,
          MaxTotalSizeMB: Number(row.MaxTotalSizeMB) || 0,
          AllowMultiple: toInt(row.AllowMultiple) !== 0,
          AcceptedTypes: row.AcceptedTypes,
        };
      }
      return config;
    });
  }

  private async loadSignatures(userUID: number, orgUID: number): Promise<Record<string, unknown>[]> {
    const rows = await this.sessionData.getUserSignatures(userUID, orgUID).catch(() => []);
    const cdnBase = (process.env.FILE_UPLOAD === "amazonaws" ? process.env.CDN_URL : process.env.CFLARE_R2_CDN) || "";
    return rows.map((sig) => ({
      SignatureUID: toInt(sig.SignatureUID),
      Label: sig.Label,
      SignatureType: sig.SignatureType,
      ImgSrc: sig.SignatureType === "Draw" ? sig.DrawData ?? "" : cdnBase + (sig.ImagePath ?? ""),
      IsDefault: toInt(sig.IsDefault),
    }));
  }

  // Login_model::_loadOrgSubscription — fails open so login is never blocked by this lookup.
  private async loadOrgSubscription(orgUID: number): Promise<NonNullable<ErpSessionPayload["Subscription"]>> {
    const subscription = { PlanName: "Free Trial", Status: "Trial", EndDate: "", GracePeriodDays: 7, IsExpired: false };
    try {
      const row = await this.sessionData.getLatestOrgSubscription(orgUID);
      if (row) {
        subscription.PlanName = row.PlanName ?? "Free Trial";
        subscription.Status = row.Status ?? "Trial";
        subscription.EndDate = row.EndDate ?? "";
        subscription.GracePeriodDays = row.GracePeriodDays === null ? 7 : toInt(row.GracePeriodDays);
        const end = parseDateTime(row.EndDate);
        const graceEnd = end ? end.getTime() + subscription.GracePeriodDays * 86400 * 1000 : 0;
        subscription.IsExpired =
          (end !== null && Date.now() > graceEnd) || ["Expired", "Cancelled", "Suspended"].includes(row.Status ?? "");
      }
    } catch (err) {
      this.logger.warn(`Subscription lookup failed for org ${orgUID}: ${(err as Error).message}`);
    }
    return subscription;
  }
}
