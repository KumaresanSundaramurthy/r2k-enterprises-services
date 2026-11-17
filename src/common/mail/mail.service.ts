import { Injectable } from "@nestjs/common";
import * as nodemailer from "nodemailer";

/* Transactional email via Brevo SMTP relay — same credentials CI3 uses so both apps share one verified sender. */
@Injectable()
export class MailService {
  get fromName(): string {
    return process.env.MAIL_FROM_NAME || "Rishika 2K Enterprises";
  }

  private get fromEmail(): string {
    return process.env.MAIL_FROM_EMAIL || "noreply@rishika2kenterprises.com";
  }

  private createTransport() {
    return nodemailer.createTransport({
      host: process.env.MAIL_HOST || "smtp-relay.brevo.com",
      port: parseInt(process.env.MAIL_PORT || "587", 10),
      secure: false,
      auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD,
      },
    });
  }

  async send(toEmail: string, toName: string, subject: string, htmlContent: string): Promise<void> {
    if (!process.env.MAIL_USERNAME || !process.env.MAIL_PASSWORD) {
      throw new Error("MAIL_USERNAME / MAIL_PASSWORD are not set");
    }
    const transport = this.createTransport();
    await transport.sendMail({
      from: `"${this.fromName}" <${this.fromEmail}>`,
      to: `"${toName}" <${toEmail}>`,
      subject,
      html: htmlContent,
    });
  }
}
