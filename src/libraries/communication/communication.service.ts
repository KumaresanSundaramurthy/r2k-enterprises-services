import { Injectable } from "@nestjs/common";
import { CiValidationError } from "../../core/response/ci-response";
import { CurlService } from "../curl/curl.service";
import { CommContact, CommunicationRepository, RecipientType } from "./communication.repository";
import { SmsService } from "./sms.service";

export type CommType = "SMS" | "Email";

// One email attachment as uploaded (multer memory storage)
export interface CommAttachment {
  name: string;
  content: Buffer;
}

export interface CommResult {
  Message: string;
  Sent: number;
  Failed: number;
}

interface Attempt {
  contact: CommContact;
  ok: boolean;
  response: unknown;
}

// What a sendCommunication call posts (CI3 Customers / Vendors::sendCommunication)
export interface CommRequest {
  commType: string;
  message: string;
  subject: string;
  uids: number[];
  files: { originalname: string; buffer: Buffer }[];
}

// Recipients are sent to a few at a time instead of one by one, so a long list stays within the request time
const SEND_BATCH_SIZE = 5;
const MAX_ATTACHMENTS = 3;
const ATTACHMENT_EXTENSIONS = ["pdf", "jpg", "jpeg", "png"];

const nowUtc = () => new Date().toISOString().slice(0, 19).replace("T", " ");

/**
 * SMS and email to customers or vendors, with one Security.CommunicationLogTbl row per recipient attempted
 * (CI3 Communicationservice). Recipients without a mobile number / email address count as failed, unlogged.
 * Validation and delivery failures are thrown as CiValidationError so the caller sees CI3's message.
 */
@Injectable()
export class CommunicationService {
  constructor(
    private readonly repository: CommunicationRepository,
    private readonly sms: SmsService,
    private readonly curl: CurlService
  ) {}

  // sendCommunication — checks the posted values, then sends SMS or email (email takes up to 3 pdf / jpg / png files)
  async send(orgUID: number, sentBy: number, recipientType: RecipientType, request: CommRequest): Promise<CommResult> {
    const message = request.message.trim();
    const subject = request.subject.trim();
    if (request.commType !== "SMS" && request.commType !== "Email") throw new CiValidationError("Invalid communication type.");
    if (!message) throw new CiValidationError("Message cannot be empty.");
    if (request.commType === "Email" && !subject) throw new CiValidationError("Email subject is required.");
    if (request.uids.length === 0) throw new CiValidationError("No recipients selected.");

    if (request.commType === "SMS") return this.sendSMS(orgUID, sentBy, recipientType, request.uids, message);
    const attachments = request.files
      .slice(0, MAX_ATTACHMENTS)
      .filter((file) => ATTACHMENT_EXTENSIONS.includes((file.originalname.split(".").pop() ?? "").toLowerCase()))
      .map((file) => ({ name: file.originalname, content: file.buffer }));
    return this.sendEmail(orgUID, sentBy, recipientType, request.uids, subject, message, attachments);
  }

  async sendSMS(orgUID: number, sentBy: number, recipientType: RecipientType, uids: number[], message: string): Promise<CommResult> {
    if (!message) throw new CiValidationError("Message cannot be empty.");
    const contacts = await this.requireContacts(recipientType, orgUID, uids);
    const provider = this.sms.provider;

    const withMobile = contacts.filter((contact) => contact.MobileNumber);
    const attempts = await this.inBatches(withMobile, async (contact) => {
      const mobile = `${contact.CountryCode ?? ""}${contact.MobileNumber}`.replace(/[^0-9]/g, "");
      const result = await this.sms.send(mobile, message);
      return { contact, ok: !result.Error, response: result.Response };
    });

    await this.saveLogs(orgUID, sentBy, "SMS", provider, recipientType, "", message, attempts);
    const sent = attempts.filter((attempt) => attempt.ok).length;
    const failed = contacts.length - sent;
    return { Message: `SMS sent to ${sent} recipient(s)` + (failed ? `, ${failed} failed.` : "."), Sent: sent, Failed: failed };
  }

  async sendEmail(
    orgUID: number,
    sentBy: number,
    recipientType: RecipientType,
    uids: number[],
    subject: string,
    htmlMessage: string,
    attachments: CommAttachment[] = []
  ): Promise<CommResult> {
    if (!subject) throw new CiValidationError("Email subject is required.");
    if (!htmlMessage) throw new CiValidationError("Message cannot be empty.");
    const contacts = await this.requireContacts(recipientType, orgUID, uids);

    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) throw new CiValidationError("BREVO_API_KEY is not configured.");
    const sender = { name: process.env.MAIL_FROM_NAME || "R2K Enterprises", email: process.env.MAIL_FROM_EMAIL || process.env.MAIL_USERNAME || "" };
    const htmlContent = CommunicationService.wrapHtmlEmail(htmlMessage);
    const attachment = attachments.map((file) => ({ content: file.content.toString("base64"), name: file.name }));

    const withEmail = contacts.filter((contact) => contact.EmailAddress);
    const attempts = await this.inBatches(withEmail, async (contact) => {
      const res = await this.curl.request("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": apiKey },
        body: {
          sender,
          to: [{ email: contact.EmailAddress, name: contact.Name ?? "" }],
          subject,
          htmlContent,
          ...(attachment.length > 0 ? { attachment } : {}),
        },
        timeoutMs: 30000,
      });
      const ok = !res.error && res.status >= 200 && res.status < 300;
      return { contact, ok, response: ok ? null : res.error || res.text };
    });

    await this.saveLogs(orgUID, sentBy, "Email", "brevo_api", recipientType, subject, htmlMessage, attempts);
    const sent = attempts.filter((attempt) => attempt.ok).length;
    const failed = contacts.length - sent;
    if (sent === 0 && failed > 0) {
      throw new CiValidationError(
        `Email delivery failed for all ${failed} recipient(s). Please check your Brevo API key and sender address configuration.`
      );
    }
    return { Message: `Email sent to ${sent} recipient(s)` + (failed ? `, ${failed} failed.` : "."), Sent: sent, Failed: failed };
  }

  private async requireContacts(recipientType: RecipientType, orgUID: number, uids: number[]): Promise<CommContact[]> {
    if (uids.length === 0) throw new CiValidationError("No recipients selected.");
    const contacts = await this.repository.findContacts(recipientType, orgUID, uids);
    if (contacts.length === 0) throw new CiValidationError("No valid recipients found.");
    return contacts;
  }

  private async inBatches(contacts: CommContact[], send: (contact: CommContact) => Promise<Attempt>): Promise<Attempt[]> {
    const attempts: Attempt[] = [];
    for (let i = 0; i < contacts.length; i += SEND_BATCH_SIZE) {
      attempts.push(...(await Promise.all(contacts.slice(i, i + SEND_BATCH_SIZE).map(send))));
    }
    return attempts;
  }

  private saveLogs(
    orgUID: number,
    sentBy: number,
    commType: CommType,
    provider: string,
    recipientType: RecipientType,
    subject: string,
    message: string,
    attempts: Attempt[]
  ): Promise<void> {
    const sentOn = nowUtc();
    return this.repository.insertLogs(
      attempts.map(({ contact, ok, response }) => ({
        OrgUID: orgUID,
        CommType: commType,
        Provider: provider,
        RecipientType: recipientType,
        RecipientUID: contact.UID,
        RecipientName: contact.Name ?? "",
        RecipientContact: (commType === "SMS" ? contact.MobileNumber : contact.EmailAddress) ?? "",
        Subject: subject,
        Message: message,
        Status: ok ? "Sent" : "Failed",
        ProviderResponse: JSON.stringify(response ?? null),
        SentBy: sentBy,
        SentOn: sentOn,
      }))
    );
  }

  // A Quill fragment is wrapped in a styled HTML document; a full document is sent as is
  private static wrapHtmlEmail(html: string): string {
    if (/<html/i.test(html)) return html;
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body { font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #333; line-height: 1.6; margin: 0; padding: 20px; }
      p { margin: 0 0 10px 0; }
      ul, ol { margin: 0 0 10px 20px; }
      a { color: #1565c0; }
    </style>
  </head>
  <body>${html}</body>
</html>`;
  }
}
