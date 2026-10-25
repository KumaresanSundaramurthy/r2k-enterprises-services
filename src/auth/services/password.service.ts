import { BadRequestException, ForbiddenException, GoneException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { MailService } from "../../common/mail/mail.service";
import { RedisService } from "../../common/redis/redis.service";
import { hashPassword, nowDateTime, parseDateTime, phpBool, toInt, verifyPassword } from "../../common/utils/php-compat";
import { ErpSessionContext } from "../interfaces/erp-session.interface";
import { ErpUserRepository } from "../repositories/erp-user.repository";
import { SecurityRepository } from "../repositories/security.repository";
import { passwordChangedEmail, passwordResetEmail } from "../emails/auth-emails";
import { appUrl } from "../utils/app-url";
import { AuthTokenService } from "./auth-token.service";
import { SessionService } from "./session.service";

const MIN_PASSWORD_LENGTH = 8;
// CI3's set-password (staff invite) page accepts 6 characters
const MIN_INVITE_PASSWORD_LENGTH = 6;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const PASSWORD_REUSE_DEPTH = 3;

const GENERIC_FORGOT_MESSAGE =
  "If this email address is registered with us, a password reset link has been sent. It expires in 15 minutes.";

@Injectable()
export class PasswordService {
  private readonly logger = new Logger(PasswordService.name);

  constructor(
    private readonly userRepository: ErpUserRepository,
    private readonly securityRepository: SecurityRepository,
    private readonly sessions: SessionService,
    private readonly tokens: AuthTokenService,
    private readonly redis: RedisService,
    private readonly mail: MailService
  ) {}

  // Login::forcedPasswordChange — the 180-day expiry flow, authorised by the changeToken from login.
  async forcedChange(changeToken: string, newPassword: string, confirmPassword: string) {
    const claims = this.tokens.verifyShortLived(
      changeToken,
      "force_password_change",
      "Your password change session has expired. Please sign in again."
    );
    const userUID = claims.uid ?? 0;
    this.assertNewPassword(newPassword, confirmPassword, MIN_PASSWORD_LENGTH);
    await this.replacePassword(userUID, newPassword);
    return { message: "Password updated. Please sign in with your new password." };
  }

  // Login::sendResetLink. Always answers the same way so the endpoint cannot be used to discover accounts.
  async forgot(email: string, ipAddress: string) {
    const user = await this.userRepository.findActiveUserByEmail(email.trim());
    if (user) {
      const token = randomBytes(32).toString("hex");
      await this.securityRepository.createPasswordReset(
        toInt(user.UserUID),
        token,
        nowDateTime(new Date(Date.now() + RESET_TOKEN_TTL_MS)),
        ipAddress
      );
      const content = passwordResetEmail(user.FirstName ?? "User", appUrl(`reset-password/${token}`));
      await this.mail
        .send(user.EmailAddress, user.FirstName ?? "User", content.subject, content.html)
        .catch((err) => this.logger.error(`Reset email to user ${user.UserUID} failed: ${(err as Error).message}`));
    }
    return { message: GENERIC_FORGOT_MESSAGE };
  }

  // Login::showResetForm — lets the client show the form, or an "expired"/"invalid" state, before submitting.
  async checkResetToken(token: string) {
    const reset = await this.securityRepository.findValidPasswordReset(token);
    if (!reset) {
      const exists = await this.securityRepository.passwordResetExists(token);
      if (exists) throw new GoneException({ message: "This reset link has expired or was already used.", status: "expired" });
      throw new NotFoundException({ message: "This reset link is invalid.", status: "invalid" });
    }
    const expiresAt = parseDateTime(reset.ExpiresAt);
    return {
      status: "valid",
      remainingSeconds: expiresAt ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : 0,
    };
  }

  // Login::doForgotReset
  async reset(token: string, newPassword: string, confirmPassword: string) {
    this.assertNewPassword(newPassword, confirmPassword, MIN_PASSWORD_LENGTH);
    const reset = await this.securityRepository.findValidPasswordReset(token);
    if (!reset) {
      throw new GoneException({ message: "This reset link has expired. Please request a new one.", status: "expired" });
    }
    if (phpBool(reset.IsLocked)) {
      throw new ForbiddenException("Your account is locked. Please contact your administrator.");
    }

    const userUID = toInt(reset.UserUID);
    await this.replacePassword(userUID, newPassword);
    await this.securityRepository.markPasswordResetUsed(token);
    // End any active session so the old password can no longer be used
    await this.sessions.revokeActiveSession(userUID);

    if (reset.EmailAddress) {
      const content = passwordChangedEmail(reset.FirstName ?? "User", appUrl("login"));
      await this.mail
        .send(reset.EmailAddress, reset.FirstName ?? "User", content.subject, content.html)
        .catch((err) => this.logger.error(`Password-changed email to user ${userUID} failed: ${(err as Error).message}`));
    }
    return { message: "Password updated successfully. You can now sign in." };
  }

  // Login::resetPassword (in-app change). The user comes from the session, never from the request body.
  async change(session: ErpSessionContext, oldPassword: string, newPassword: string, confirmPassword: string) {
    const userUID = toInt(session.data.User.UserUID);
    const stored = await this.userRepository.findPasswordHash(userUID);
    if (!(await verifyPassword(oldPassword, stored))) {
      throw new BadRequestException("Old password does not match. Please try again.");
    }
    this.assertNewPassword(newPassword, confirmPassword, MIN_PASSWORD_LENGTH);
    await this.replacePassword(userUID, newPassword);

    // The user must sign in again with the new password
    await this.sessions.revokeActiveSession(userUID);
    await this.redis.del(session.key);
    return { message: "Updated Successfully", requireReLogin: true };
  }

  // Setpassword::index — state of a staff-invite link.
  async checkSetPasswordToken(token: string) {
    const user = await this.userRepository.findByPasswordSetToken(token);
    if (!user) {
      throw new NotFoundException({ message: "This link is invalid.", state: "invalid" });
    }
    const base = { firstName: user.FirstName, email: user.EmailAddress };
    if (phpBool(user.IsPasswordSet)) {
      return { state: "already_set", ...base };
    }
    return { state: "form", ...base };
  }

  // Setpassword::submit — stores a bcrypt hash (CI3 stored base64 here).
  async setInitialPassword(token: string, password: string, confirmPassword: string) {
    const user = await this.userRepository.findByPasswordSetToken(token);
    if (!user) {
      throw new NotFoundException({ message: "This link is invalid.", state: "invalid" });
    }
    if (phpBool(user.IsPasswordSet)) {
      throw new BadRequestException({ message: "A password has already been set for this account.", state: "already_set" });
    }
    this.assertNewPassword(password, confirmPassword, MIN_INVITE_PASSWORD_LENGTH);
    await this.userRepository.updatePassword(toInt(user.UserUID), await hashPassword(password), { IsPasswordSet: 1 });
    return { state: "success", message: "Your password has been set. You can now sign in." };
  }

  private assertNewPassword(password: string, confirmPassword: string, minLength: number): void {
    if (password.length < minLength) {
      throw new BadRequestException(`Password must be at least ${minLength} characters.`);
    }
    if (password !== confirmPassword) {
      throw new BadRequestException("Passwords do not match.");
    }
  }

  // Rejects any of the last 3 passwords, saves the new bcrypt hash and records the old one in history.
  private async replacePassword(userUID: number, newPassword: string): Promise<void> {
    const recentHashes = await this.userRepository.getRecentPasswordHashes(userUID, PASSWORD_REUSE_DEPTH).catch(() => []);
    for (const hash of recentHashes) {
      if (await verifyPassword(newPassword, hash)) {
        throw new BadRequestException("You cannot reuse one of your last 3 passwords.");
      }
    }
    const currentHash = await this.userRepository.findPasswordHash(userUID);
    await this.userRepository.updatePassword(userUID, await hashPassword(newPassword));
    if (currentHash) {
      await this.userRepository
        .addPasswordHistory(userUID, currentHash)
        .catch((err) => this.logger.error(`Password history for user ${userUID} failed: ${(err as Error).message}`));
    }
  }
}
