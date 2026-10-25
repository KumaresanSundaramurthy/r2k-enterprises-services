import { Injectable } from "@nestjs/common";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";
import { nowDateTime } from "../../common/utils/php-compat";
import { DeviceInfo } from "../utils/device-info";

export interface LoginAuditInput {
  userUID: number | null;
  orgUID: number | null;
  branchUID: number | null;
  status: "SUCCESS" | "FAILED";
  loginType?: string;
  attemptedUsername: string;
  failureReason?: string;
  ipAddress: string;
  userAgent: string;
  device: DeviceInfo;
}

export interface ResetTokenRow {
  ResetUID: string;
  UserUID: string;
  ExpiresAt: string;
  FirstName: string | null;
  EmailAddress: string | null;
  IsLocked: string | null;
}

@Injectable()
export class SecurityRepository {
  async insertLoginAudit(input: LoginAuditInput): Promise<number | null> {
    const row: Record<string, unknown> = {
      UserUID: input.userUID,
      OrgUID: input.orgUID,
      BranchUID: input.branchUID,
      LoginStatus: input.status,
      AttemptedUsername: input.attemptedUsername,
      IPAddress: input.ipAddress,
      UserAgent: input.userAgent,
      DeviceType: input.device.deviceType,
      Browser: input.device.browser,
      OS: input.device.os,
    };
    if (input.status === "SUCCESS") {
      row.LoginType = input.loginType ?? "WEB";
      row.TokenIssued = 1;
    } else {
      row.FailureReason = input.failureReason ?? null;
    }
    const [auditID] = await erpKnexWrite("Security.UserLoginAudit").insert(row);
    return auditID ?? null;
  }

  async countRecentFailures(attemptedUsername: string, hours = 1): Promise<number> {
    const since = nowDateTime(new Date(Date.now() - hours * 3600 * 1000));
    const row = await erpKnexRead("Security.UserLoginAudit")
      .count({ total: "*" })
      .where({ AttemptedUsername: attemptedUsername, LoginStatus: "FAILED" })
      .andWhere("LoginTime", ">=", since)
      .first();
    return Number(row?.total ?? 0);
  }

  async closeLoginAudit(auditID: number): Promise<void> {
    const row = await erpKnexRead("Security.UserLoginAudit").select("LoginTime").where({ AuditID: auditID }).first();
    if (!row) return;
    const loginTime = new Date(`${String(row.LoginTime).replace(" ", "T")}Z`).getTime();
    await erpKnexWrite("Security.UserLoginAudit")
      .where({ AuditID: auditID })
      .update({
        LogoutTime: nowDateTime(),
        SessionDuration: Number.isNaN(loginTime) ? null : Math.round((Date.now() - loginTime) / 1000),
      });
  }

  async insertLoginAttempt(input: {
    userUID: number;
    username: string;
    status: string;
    subscriptionStatus: string;
    ipAddress: string;
    userAgent: string;
  }): Promise<void> {
    await erpKnexWrite("Users.LoginAttemptLogTbl").insert({
      UserUID: input.userUID,
      Username: input.username,
      AttemptStatus: input.status,
      SubscriptionStatus: input.subscriptionStatus,
      IPAddress: input.ipAddress,
      UserAgent: input.userAgent,
      AttemptTime: nowDateTime(),
      ErrorMessage: null,
    });
  }

  async createPasswordReset(userUID: number, token: string, expiresAt: string, ipAddress: string): Promise<void> {
    await erpKnexWrite("Users.PasswordResetTbl").insert({
      UserUID: userUID,
      Token: token,
      ExpiresAt: expiresAt,
      IPAddress: ipAddress,
    });
  }

  async findValidPasswordReset(token: string): Promise<ResetTokenRow | null> {
    const row = await erpKnexRead("Users.PasswordResetTbl as r")
      .select("r.ResetUID", "r.UserUID", "r.ExpiresAt", "u.FirstName", "u.EmailAddress", "u.IsLocked")
      .leftJoin("Users.UserTbl as u", "u.UserUID", "r.UserUID")
      .where({ "r.Token": token, "r.IsUsed": 0 })
      .andWhere("r.ExpiresAt", ">", nowDateTime())
      .first();
    return row ?? null;
  }

  async passwordResetExists(token: string): Promise<boolean> {
    const row = await erpKnexRead("Users.PasswordResetTbl").select("ResetUID").where({ Token: token }).first();
    return !!row;
  }

  async markPasswordResetUsed(token: string): Promise<void> {
    await erpKnexWrite("Users.PasswordResetTbl").where({ Token: token }).update({ IsUsed: 1 });
  }
}
