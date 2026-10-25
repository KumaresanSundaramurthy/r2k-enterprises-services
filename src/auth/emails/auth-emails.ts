import { escapeHtml } from "../../common/utils/php-compat";

// HTML bodies ported from CI3 (Login controller, Signup_model, Subscription library) so users get identical emails.

export interface EmailContent {
  subject: string;
  html: string;
}

const year = () => new Date().getUTCFullYear();

function darkLayout(accent: string, banner: string, bannerColor: string, body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#040b18;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#040b18;padding:40px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#060e20;border-radius:16px;overflow:hidden;border:1px solid rgba(${accent},0.22);max-width:560px;width:100%;">
      <tr><td style="padding:30px 40px 24px;border-bottom:1px solid rgba(${accent},0.12);">
        <span style="font-size:20px;font-weight:800;color:#f59e0b;letter-spacing:-0.3px;">RISHIKA 2K</span>
        <span style="font-size:20px;font-weight:300;color:#e2e8f0;"> ENTERPRISES</span>
        <p style="margin:5px 0 0;font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:1.5px;">Billing Management System</p>
      </td></tr>
      <tr><td style="background:${bannerColor};padding:8px 40px;">
        ${banner}
      </td></tr>
      <tr><td style="padding:32px 40px;">
${body}
      </td></tr>
      <tr><td style="padding:16px 40px;border-top:1px solid rgba(${accent},0.1);background:rgba(${accent},0.03);">
        <p style="margin:0;font-size:11px;color:#334155;text-align:center;">&copy; ${year()} Rishika 2K Enterprises &middot; Agricultural Machinery &middot; Tamil Nadu</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export function passwordResetEmail(firstName: string, resetLink: string): EmailContent {
  const name = escapeHtml(firstName);
  const body = `        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:#f1f5f9;">Hi ${name},</p>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.7;">We received a request to reset your account password. Click the button below — this link is valid for <strong style="color:#f59e0b;">15 minutes only</strong> and can be used once.</p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
          <tr><td>
            <a href="${resetLink}" style="display:inline-block;padding:13px 30px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#040b18;font-size:14px;font-weight:700;text-decoration:none;border-radius:10px;">Reset My Password</a>
          </td></tr>
        </table>
        <p style="margin:0 0 6px;font-size:12px;color:#64748b;">Button not working? Copy this link into your browser:</p>
        <p style="margin:0 0 24px;font-size:12px;color:#f59e0b;word-break:break-all;">${resetLink}</p>
        <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:18px;">
          <p style="margin:0;font-size:12px;color:#475569;line-height:1.6;">If you did not request this, ignore this email — your password will not change. For security, this link can only be used once.</p>
        </div>`;
  return {
    subject: "Password Reset — Rishika 2K Enterprises",
    html: darkLayout(
      "245,158,11",
      '<span style="font-size:12px;font-weight:700;color:#040b18;letter-spacing:1px;">PASSWORD RESET REQUEST</span>',
      "linear-gradient(90deg,#f59e0b,#d97706)",
      body
    ),
  };
}

export function passwordChangedEmail(firstName: string, loginUrl: string): EmailContent {
  const name = escapeHtml(firstName);
  const changedAt = new Date().toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
  const body = `        <p style="margin:0 0 6px;font-size:15px;font-weight:600;color:#f1f5f9;">Hi ${name},</p>
        <p style="margin:0 0 24px;font-size:14px;color:#94a3b8;line-height:1.7;">
          Your account password was successfully changed on <strong style="color:#f1f5f9;">${changedAt}</strong>.<br>
          You can now sign in with your new password.
        </p>
        <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
          <tr><td>
            <a href="${loginUrl}" style="display:inline-block;padding:13px 30px;background:linear-gradient(135deg,#10b981,#059669);color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;border-radius:10px;">Sign In Now</a>
          </td></tr>
        </table>
        <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:16px 20px;">
          <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#fca5a5;">&#9888;&nbsp; Did not make this change?</p>
          <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
            If you did not reset your password, your account may be at risk. Please contact your administrator immediately or request another password reset.
          </p>
        </div>`;
  return {
    subject: "Your Password Has Been Changed — Rishika 2K Enterprises",
    html: darkLayout(
      "16,185,129",
      '<span style="font-size:12px;font-weight:700;color:#ffffff;letter-spacing:1px;">&#10003;&nbsp; PASSWORD CHANGED SUCCESSFULLY</span>',
      "linear-gradient(90deg,#10b981,#059669)",
      body
    ),
  };
}

export function emailVerificationEmail(firstName: string, verifyUrl: string, fromName: string): EmailContent {
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    "<style>body{font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;margin:0;padding:20px;}" +
    ".btn{display:inline-block;padding:12px 28px;background:#f59e0b;color:#0a1628;text-decoration:none;border-radius:8px;font-size:14px;font-weight:700;}" +
    "</style></head><body>" +
    `<p>Hi ${escapeHtml(firstName)},</p>` +
    "<p>Thank you for signing up! Please verify your email address by clicking the button below:</p>" +
    `<p style="margin:24px 0;"><a class="btn" href="${verifyUrl}">Verify Email Address</a></p>` +
    "<p>If the button does not work, copy and paste this link into your browser:<br>" +
    `<a href="${verifyUrl}">${verifyUrl}</a></p>` +
    "<p>This link will expire in <strong>24 hours</strong>.</p>" +
    `<p>Regards,<br>${fromName}</p>` +
    "</body></html>";
  return { subject: `Verify your email address — ${fromName}`, html };
}

export function subscriptionExpiryEmail(name: string, days: number, fromName: string): EmailContent {
  const dayText = days === 1 ? "1 day" : `${days} days`;
  const accent = days === 1 ? "#dc2626" : days <= 3 ? "#d97706" : "#2563eb";
  const subject = `${days === 1 ? "URGENT: " : ""}Your subscription expires in ${days} day${days > 1 ? "s" : ""}`;
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <tr><td style="background:${accent};padding:20px 32px;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">${fromName}</p>
          <p style="margin:4px 0 0;font-size:12px;color:rgba(255,255,255,.85);">Subscription Notice</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:15px;color:#111;">Dear ${escapeHtml(name)},</p>
          <p style="margin:0 0 16px;font-size:15px;color:#374151;">
            This is a reminder that your subscription will expire in
            <strong style="color:${accent};">${dayText}</strong>.
          </p>
          <p style="margin:0 0 24px;font-size:15px;color:#374151;">
            To avoid any interruption in your service, please renew your subscription before it expires.
          </p>
          <p style="margin:0 0 32px;font-size:15px;color:#374151;">
            If you have already renewed, you may disregard this message.
          </p>
          <p style="margin:0;font-size:14px;color:#6b7280;">
            Thank you,<br><strong>${fromName}</strong>
          </p>
        </td></tr>
        <tr><td style="background:#f9fafb;padding:14px 32px;border-top:1px solid #e5e7eb;">
          <p style="margin:0;font-size:11px;color:#9ca3af;text-align:center;">
            This is an automated message. Please do not reply to this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html };
}
