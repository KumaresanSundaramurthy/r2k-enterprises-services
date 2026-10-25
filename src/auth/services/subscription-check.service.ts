import { Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { MailService } from "../../common/mail/mail.service";
import { RedisService } from "../../common/redis/redis.service";
import { nowDateTime, parseDateTime, toInt, todayDate } from "../../common/utils/php-compat";
import { SubscriptionRepository } from "../repositories/subscription.repository";
import { SecurityRepository } from "../repositories/security.repository";
import { RequestMeta } from "../utils/device-info";
import { subscriptionExpiryEmail } from "../emails/auth-emails";

export interface SubscriptionCheck {
  isValid: boolean;
  status: string;
  message: string;
  daysRemaining: number;
  inGracePeriod: boolean;
  plan?: string;
}

const DAY_MS = 86400 * 1000;

// PHP DateInterval '%r%a': whole days between the two dates, signed.
function signedWholeDays(from: Date, to: Date): number {
  const diff = to.getTime() - from.getTime();
  return Math.sign(diff) * Math.floor(Math.abs(diff) / DAY_MS);
}

// Port of CI3's Subscription library checks that run on every login.
@Injectable()
export class SubscriptionCheckService {
  private readonly logger = new Logger(SubscriptionCheckService.name);

  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
    private readonly securityRepository: SecurityRepository,
    private readonly redis: RedisService,
    private readonly mail: MailService
  ) {}

  async check(userUID: number): Promise<SubscriptionCheck> {
    const result: SubscriptionCheck = { isValid: false, status: "Unknown", message: "", daysRemaining: 0, inGracePeriod: false };
    try {
      const sub = await this.subscriptionRepository.getUserSubscription(userUID);
      if (!sub) {
        result.message = "User not found";
        return result;
      }
      const status = sub.SubscriptionStatus ?? "";
      result.status = status;
      result.plan = sub.SubscriptionPlan ?? undefined;

      if (status === "PendingPayment") {
        // Paid-plan signup with payment not completed — login is allowed so the client can send them to /subscribe.
        return {
          ...result,
          isValid: true,
          message: "Payment pending. Please complete your subscription payment to activate your account.",
        };
      }

      if (status === "Active" || status === "Trial") {
        const endDate = parseDateTime(sub.SubscriptionEndDate);
        if (!endDate) {
          result.message = "No subscription end date set.";
          return result;
        }
        const now = new Date();
        const daysRemaining = signedWholeDays(now, endDate);
        result.daysRemaining = daysRemaining;
        if (now < endDate) {
          result.isValid = true;
          result.message = `Subscription active. ${daysRemaining} days remaining.`;
        } else {
          const graceEnd = new Date(endDate.getTime() + toInt(sub.GracePeriodDays) * DAY_MS);
          if (now <= graceEnd) {
            const graceRemaining = Math.floor((graceEnd.getTime() - now.getTime()) / DAY_MS);
            result.isValid = true;
            result.inGracePeriod = true;
            result.daysRemaining = -Math.abs(daysRemaining);
            result.message = `Subscription expired but in grace period. ${graceRemaining} days remaining.`;
          } else {
            result.message = "Subscription expired. Please renew to continue.";
            await this.subscriptionRepository.markLatestExpired(toInt(sub.OrgUID));
          }
        }
      } else if (status === "Expired") {
        result.message = "Your subscription has expired. Please renew to continue using the service.";
      } else if (status === "Suspended") {
        result.message = "Your account has been suspended. Please contact support.";
      } else if (status === "Cancelled") {
        result.message = "Your subscription has been cancelled.";
      } else {
        result.message = "No active subscription found for your organisation. Please contact support.";
      }

      if (result.isValid && result.daysRemaining > 0 && result.daysRemaining <= 7) {
        await this.sendExpiryWarning(userUID, result.daysRemaining);
      }
    } catch (err) {
      this.logger.error(`Subscription check failed for user ${userUID}: ${(err as Error).message}`);
      result.message = `Error checking subscription: ${(err as Error).message}`;
    }
    return result;
  }

  async logLoginAttempt(userUID: number, username: string, subscriptionStatus: string, meta: RequestMeta): Promise<void> {
    await this.securityRepository
      .insertLoginAttempt({
        userUID,
        username,
        status: "Success",
        subscriptionStatus,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      })
      .catch((err) => this.logger.error(`Login attempt log failed: ${(err as Error).message}`));
  }

  // One-time token the renew page uses to identify the org (same Redis key CI3 reads).
  async createRenewToken(orgUID: number): Promise<string> {
    const token = randomBytes(16).toString("hex");
    await this.redis.set(this.redis.envKey(`rnt_${token}`), { orgUID, createdAt: Math.floor(Date.now() / 1000) }, 604800);
    return token;
  }

  private async sendExpiryWarning(userUID: number, daysRemaining: number): Promise<void> {
    if (![7, 3, 1].includes(daysRemaining)) return;
    const notificationType = `Expiry_Warning_${daysRemaining}Days`;
    try {
      if (await this.subscriptionRepository.wasNotificationSentToday(userUID, notificationType, todayDate())) return;
      const contact = await this.subscriptionRepository.getUserContact(userUID);
      if (!contact) return;

      const notificationUID = await this.subscriptionRepository.insertNotification({
        UserUID: userUID,
        NotificationType: notificationType,
        NotificationData: JSON.stringify({ daysRemaining }),
        SentOn: nowDateTime(),
        EmailSent: 0,
      });
      if (!contact.EmailAddress || !notificationUID) return;

      const fullName = `${contact.FirstName ?? ""} ${contact.LastName ?? ""}`.trim() || "Valued Customer";
      const email = subscriptionExpiryEmail(fullName, daysRemaining, this.mail.fromName);
      await this.mail.send(contact.EmailAddress, fullName, email.subject, email.html);
      await this.subscriptionRepository.markNotificationEmailSent(notificationUID);
    } catch (err) {
      this.logger.error(`Expiry warning for user ${userUID} failed: ${(err as Error).message}`);
    }
  }
}
