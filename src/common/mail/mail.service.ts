import { Injectable } from "@nestjs/common";

// Transactional email through Brevo, the same provider and env vars CI3 uses.
@Injectable()
export class MailService {
  get fromName(): string {
    return process.env.MAIL_FROM_NAME || "Rishika 2K Enterprises";
  }

  async send(toEmail: string, toName: string, subject: string, htmlContent: string): Promise<void> {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      throw new Error("BREVO_API_KEY is not set");
    }
    const fromEmail = process.env.MAIL_FROM_EMAIL || "noreply@rishika2kenterprises.com";

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: this.fromName, email: fromEmail },
        to: [{ email: toEmail, name: toName }],
        subject,
        htmlContent,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`Email delivery failed (HTTP ${res.status}): ${await res.text()}`);
    }
  }
}
