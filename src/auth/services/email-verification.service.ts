import { BadRequestException, GoneException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { MailService } from "../../common/mail/mail.service";
import { nowDateTime, parseDateTime, phpBool, toInt } from "../../common/utils/php-compat";
import { OrganisationRepository } from "../repositories/organisation.repository";
import { emailVerificationEmail } from "../emails/auth-emails";
import { appUrl } from "../utils/app-url";

const VERIFY_TOKEN_TTL_MS = 24 * 3600 * 1000;

const GENERIC_RESEND_MESSAGE =
  "If this account is registered and unverified, a new verification link has been sent. Please check your inbox.";

// Organisation email verification — Login::verifyEmail / resendVerificationEmail and Signup_model::sendVerificationEmail.
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly organisationRepository: OrganisationRepository,
    private readonly mail: MailService
  ) {}

  async verify(token: string) {
    const org = await this.organisationRepository.findByVerifyToken(token);
    if (!org) {
      throw new NotFoundException({
        status: "invalid",
        message: "This verification link is invalid. It may have already been used or the link is incorrect.",
      });
    }
    if (phpBool(org.IsEmailVerified)) {
      return { status: "already_verified", message: "Your email address has already been verified. You can log in now." };
    }
    const expiry = parseDateTime(org.EmailVerifyExpiry);
    if (!expiry || expiry.getTime() < Date.now()) {
      throw new GoneException({
        status: "expired",
        message: "This verification link has expired. Links are valid for 24 hours only. Please request a new one.",
      });
    }
    await this.organisationRepository.update(toInt(org.OrgUID), {
      IsEmailVerified: 1,
      EmailVerifyToken: null,
      EmailVerifyExpiry: null,
    });
    return { status: "success", message: "Your email address has been verified successfully. You can now log in." };
  }

  async resend(identifier: string) {
    const value = identifier.trim().toLowerCase();
    if (!value) {
      throw new BadRequestException("Please enter your username or email.");
    }
    const org = value.includes("@")
      ? await this.organisationRepository.findUnverifiedByEmail(value)
      : await this.organisationRepository.findUnverifiedByUserName(value);
    if (org) {
      await this.sendVerificationEmail(toInt(org.OrgUID), org.FirstName || "there", org.OrgEmail.trim().toLowerCase()).catch(
        (err) => this.logger.error(`Verification email for org ${org.OrgUID} failed: ${(err as Error).message}`)
      );
    }
    return { message: GENERIC_RESEND_MESSAGE };
  }

  async sendVerificationEmail(orgUID: number, firstName: string, email: string): Promise<void> {
    const token = randomBytes(32).toString("hex");
    const affected = await this.organisationRepository.setEmailVerifyToken(
      orgUID,
      token,
      nowDateTime(new Date(Date.now() + VERIFY_TOKEN_TTL_MS))
    );
    if (affected === 0) {
      throw new Error(`No organisation row updated for OrgUID=${orgUID}`);
    }
    const content = emailVerificationEmail(firstName, appUrl(`verify-email/${token}`), this.mail.fromName);
    await this.mail.send(email, firstName, content.subject, content.html);
  }
}
