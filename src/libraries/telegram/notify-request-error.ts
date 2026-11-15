import { ArgumentsHost } from "@nestjs/common";
import { Request } from "express";
import { TelegramNotifier } from "./telegram-notifier";

const pick = (req: Request, key: string): unknown => {
  const query = req.query as Record<string, unknown> | undefined;
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const value = query?.[key] ?? body[key];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * CI3 notifyError() for a failed request: the route as the title, plus the organisation, branch and user the
 * caller sent (orgId / branchId / userId, CI3's JwtData), the HTTP method and the full URL.
 */
export function notifyRequestError(host: ArgumentsHost, exception: unknown): void {
  if (host.getType() !== "http") {
    TelegramNotifier.error("Unhandled error", exception);
    return;
  }
  const req = host.switchToHttp().getRequest<Request>();
  const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
  const orgId = pick(req, "orgId");
  const userId = pick(req, "userId");
  const branchId = pick(req, "branchId");

  TelegramNotifier.error(
    `${req.method} ${route}`,
    exception,
    {
      Organisation: orgId !== undefined ? `#${orgId}` : "—",
      "Org Branch": branchId !== undefined ? `#${branchId}` : "—",
      "Triggered By": userId !== undefined ? `#${userId}` : "—",
      "HTTP Method": req.method,
    },
    `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`
  );
}
