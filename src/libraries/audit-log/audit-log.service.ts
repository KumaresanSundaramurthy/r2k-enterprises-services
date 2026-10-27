import { Injectable, Logger } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";

export type AuditCategory = "SYSTEM" | "SECURITY" | "TRANSACTION" | "MASTER" | "PAYMENT" | "SETTINGS";

export interface AuditEntry {
  action: string;
  entityType: string;
  entityUID: number;
  entityRef?: string;
  details?: Record<string, unknown>;
  summary?: string;
  module?: string;
  category?: AuditCategory;
  result?: "SUCCESS" | "FAILED";
  errorMessage?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
}

const clip = (value: string | undefined, max: number): string | null => (value ? value.slice(0, max) : null);
const jsonOrNull = (value: Record<string, unknown> | undefined): string | null =>
  value && Object.keys(value).length > 0 ? JSON.stringify(value) : null;

function deviceTypeOf(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (ua === "") return "Unknown";
  if (ua.includes("bot") || ua.includes("crawl") || ua.includes("spider")) return "Bot";
  if (ua.includes("tablet") || ua.includes("ipad")) return "Tablet";
  if (ua.includes("mobile") || ua.includes("android") || ua.includes("iphone")) return "Mobile";
  return "Desktop";
}

/** User action log in Security.UserAuditLogTbl (CI3 Auditlog). Never fails the request it records. */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly db: DatabaseService) {}

  async log(ctx: WriteContext, entry: AuditEntry): Promise<void> {
    try {
      // CI3 takes the display name from the session; here it is read from the user record
      const user = await this.db.read("Users.UserTbl").select("FirstName", "LastName").where({ UserUID: ctx.userUID }).first();
      const userName = user ? `${user.FirstName ?? ""} ${user.LastName ?? ""}`.trim() : "";

      await this.db.write("Security.UserAuditLogTbl").insert({
        OrgUID: ctx.orgUID,
        UserUID: ctx.userUID,
        UserName: clip(userName, 120),
        Action: entry.action.slice(0, 50),
        EntityType: entry.entityType.slice(0, 30),
        Module: (entry.module || entry.entityType).slice(0, 60),
        EntityUID: entry.entityUID,
        EntityRef: clip(entry.entityRef, 100),
        Summary: clip(entry.summary, 500),
        IPAddress: ctx.ipAddress && ctx.ipAddress !== "0.0.0.0" ? ctx.ipAddress : null,
        Details: jsonOrNull(entry.details),
        AuditCategory: entry.category ?? null,
        Result: entry.result ?? "SUCCESS",
        ErrorMessage: clip(entry.errorMessage, 500),
        Source: "WEB",
        SessionID: null,
        UserAgent: clip(ctx.userAgent, 500),
        DeviceType: deviceTypeOf(ctx.userAgent),
        OldValues: jsonOrNull(entry.oldValues),
        NewValues: jsonOrNull(entry.newValues),
        FormDataJson: null,
      });
    } catch (err) {
      this.logger.error(`Audit log ${entry.action} failed: ${(err as Error).message}`);
    }
  }
}
