import { ArgumentsHost } from "@nestjs/common";
import { Request } from "express";
import { TelegramNotifier } from "./telegram-notifier";

const pick = (req: Request, key: string): unknown => {
  const query = req.query as Record<string, unknown> | undefined;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const value = query?.[key] ?? body[key];
  return Array.isArray(value) ? value[0] : value;
};

// The route as the title, plus the organisation, branch and user the caller sent (CI3's JwtData), method and URL
function requestDetails(host: ArgumentsHost) {
  const req = host.switchToHttp().getRequest<Request>();
  const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
  const orgId = pick(req, "orgId");
  const userId = pick(req, "userId");
  const branchId = pick(req, "branchId");
  return {
    title: `${req.method} ${route}`,
    context: {
      Organisation: orgId !== undefined ? `#${orgId}` : "—",
      "Org Branch": branchId !== undefined ? `#${branchId}` : "—",
      "Triggered By": userId !== undefined ? `#${userId}` : "—",
      "HTTP Method": req.method,
    },
    url: `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`,
  };
}

/** CI3 notifyError() for a failed request (unexpected error or server failure) — always sent. */
export function notifyRequestError(host: ArgumentsHost, exception: unknown): void {
  if (host.getType() !== "http") {
    TelegramNotifier.error("Unhandled error", exception);
    return;
  }
  const { title, context, url } = requestDetails(host);
  TelegramNotifier.error(title, exception, context, url);
}

/** A request refused with a validation / user message — sent only when TELEGRAM_NOTIFY_LEVEL is "all". */
export function notifyRequestValidation(host: ArgumentsHost, message: string): void {
  if (host.getType() !== "http" || !TelegramNotifier.notifyValidation()) return;
  const { title, context, url } = requestDetails(host);
  TelegramNotifier.validation(title, message, context, url);
}
