import { Injectable } from "@nestjs/common";
import { CurlService } from "../curl/curl.service";

// Result of one SMS: the provider's parsed response is stored in the communication log
export interface SmsResult {
  Error: boolean;
  Message: string;
  Response: unknown;
}

interface SmsDriver {
  send(mobile: string, message: string): Promise<SmsResult>;
}

// CI3 drivers/Fast2SmsDriver.php
class Fast2SmsDriver implements SmsDriver {
  constructor(private readonly curl: CurlService) {}

  async send(mobile: string, message: string): Promise<SmsResult> {
    const res = await this.curl.request<{ return?: boolean; message?: string | string[] }>("https://www.fast2sms.com/dev/bulk", {
      method: "POST",
      headers: { authorization: process.env.FAST2SMS_API_KEY ?? "", "cache-control": "no-cache" },
      body: {
        route: "q",
        sender_id: process.env.FAST2SMS_SENDER_ID || "FSTSMS",
        message,
        language: "english",
        flash: 0,
        numbers: mobile,
        dlt_te_id: process.env.FAST2SMS_DLT_TE_ID || "",
      },
      timeoutMs: 30000,
    });
    if (res.error) return { Error: true, Message: `cURL error: ${res.error}`, Response: null };

    const resp = res.data;
    if (resp && resp.return === true) return { Error: false, Message: "SMS sent successfully", Response: resp };
    const detail = Array.isArray(resp?.message) ? resp.message.join(", ") : resp?.message || "Fast2SMS error";
    return { Error: true, Message: detail, Response: resp };
  }
}

// CI3 drivers/BrevoSmsDriver.php
class BrevoSmsDriver implements SmsDriver {
  constructor(private readonly curl: CurlService) {}

  async send(mobile: string, message: string): Promise<SmsResult> {
    const res = await this.curl.request<{ message?: string }>("https://api.brevo.com/v3/transactionalSMS/sms", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_SMS_API_KEY ?? "" },
      body: { sender: process.env.BREVO_SMS_SENDER || "R2K", recipient: BrevoSmsDriver.formatMobile(mobile), content: message, type: "transactional" },
      timeoutMs: 30000,
    });
    if (res.error) return { Error: true, Message: `cURL error: ${res.error}`, Response: null };
    if (res.status === 200 || res.status === 201) return { Error: false, Message: "SMS sent successfully", Response: res.data };
    return { Error: true, Message: res.data?.message ?? `Brevo error ${res.status}`, Response: res.data };
  }

  // Digits and '+' only; numbers without a country code are taken as Indian (+91)
  private static formatMobile(mobile: string): string {
    const cleaned = mobile.replace(/[^0-9+]/g, "");
    return cleaned.startsWith("+") ? cleaned : `+91${cleaned.replace(/^0+/, "")}`;
  }
}

/** SMS through the provider set in SMS_PROVIDER: fast2sms (default) or brevo (CI3 Smsservice). */
@Injectable()
export class SmsService {
  constructor(private readonly curl: CurlService) {}

  get provider(): string {
    return (process.env.SMS_PROVIDER || "fast2sms").trim().toLowerCase();
  }

  send(mobile: string, message: string): Promise<SmsResult> {
    const driver: SmsDriver = this.provider === "brevo" ? new BrevoSmsDriver(this.curl) : new Fast2SmsDriver(this.curl);
    return driver.send(mobile, message);
  }
}
