import { Injectable } from "@nestjs/common";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";

export interface PublicPlanRow {
  SectorPlanUID: number;
  SectorUID: number;
  PlanUID: number;
  Price: string;
  TaxableAmount: string;
  TaxAmount: string;
  TotalAmount: string;
  DurationDays: number;
  MaxUsers: number;
  MaxBranches: number;
  PlanName: string;
  PlanCode: string;
  BillingCycle: string;
  SectorName: string;
  SectorCode: string;
}

export interface PlanModuleRow {
  ModuleUID: number;
  DisplayName: string;
  Icon: string | null;
  IconBg: string | null;
  IconColor: string | null;
  Description: string | null;
}

export interface AllPlanModuleRow extends PlanModuleRow {
  PlanUID: number;
  SectorUID: number;
}

export interface UserSubscriptionRow {
  UserUID: string;
  OrgUID: string;
  OrgSubUID: string | null;
  SubscriptionStatus: string | null;
  SubscriptionPlan: string | null;
  SubscriptionEndDate: string | null;
  GracePeriodDays: string | null;
}

@Injectable()
export class SubscriptionRepository {
  async getUserSubscription(userUID: number): Promise<UserSubscriptionRow | null> {
    const row = await erpKnexRead("Users.UserTbl as U")
      .select(
        "U.UserUID",
        "U.OrgUID",
        "OS.OrgSubUID",
        "OS.Status as SubscriptionStatus",
        erpKnexRead.raw("COALESCE(SP.PlanName, 'Trial') AS SubscriptionPlan"),
        "OS.EndDate as SubscriptionEndDate",
        "OS.GracePeriodDays"
      )
      .leftJoin("Billing.OrgSubscriptionTbl as OS", function () {
        this.on("OS.OrgUID", "U.OrgUID").andOn("OS.Status", "!=", erpKnexRead.raw("'Cancelled'"));
      })
      .leftJoin("Billing.SectorPlanTbl as SPT", "SPT.SectorPlanUID", "OS.SectorPlanUID")
      .leftJoin("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .where("U.UserUID", userUID)
      .orderBy("OS.StartDate", "desc")
      .first();
    return row ?? null;
  }

  async markLatestExpired(orgUID: number): Promise<void> {
    await erpKnexWrite.raw(
      "UPDATE Billing.OrgSubscriptionTbl SET Status = ? WHERE OrgUID = ? AND Status != ? ORDER BY StartDate DESC LIMIT 1",
      ["Expired", orgUID, "Cancelled"]
    );
  }

  async wasNotificationSentToday(userUID: number, notificationType: string, today: string): Promise<boolean> {
    const row = await erpKnexRead("Users.SubscriptionNotificationTbl")
      .select("NotificationUID")
      .where({ UserUID: userUID, NotificationType: notificationType })
      .andWhere("SentOn", ">=", `${today} 00:00:00`)
      .andWhere("SentOn", "<=", `${today} 23:59:59`)
      .first();
    return !!row;
  }

  async insertNotification(data: Record<string, unknown>): Promise<number> {
    const [id] = await erpKnexWrite("Users.SubscriptionNotificationTbl").insert(data);
    return id;
  }

  async markNotificationEmailSent(notificationUID: number): Promise<void> {
    await erpKnexWrite("Users.SubscriptionNotificationTbl").where({ NotificationUID: notificationUID }).update({ EmailSent: 1 });
  }

  async getUserContact(
    userUID: number
  ): Promise<{ EmailAddress: string | null; FirstName: string | null; LastName: string | null } | null> {
    const row = await erpKnexRead("Users.UserTbl")
      .select("EmailAddress", "FirstName", "LastName")
      .where({ UserUID: userUID })
      .first();
    return row ?? null;
  }

  async getPublicPlans(): Promise<PublicPlanRow[]> {
    return erpKnexRead("Billing.SectorPlanTbl as SPT")
      .select(
        "SPT.SectorPlanUID", "SPT.SectorUID", "SPT.PlanUID", "SPT.Price",
        "SPT.TaxableAmount", "SPT.TaxAmount", "SPT.TotalAmount",
        "SPT.DurationDays", "SPT.MaxUsers", "SPT.MaxBranches",
        "SP.PlanName", "SP.PlanCode", "SP.BillingCycle",
        "S.SectorName", "S.SectorCode"
      )
      .join("Billing.SubscriptionPlansTbl as SP", function () {
        this.on("SP.PlanUID", "SPT.PlanUID").andOn("SP.IsActive", erpKnexRead.raw("1"));
      })
      .join("Billing.SectorsTbl as S", function () {
        this.on("S.SectorUID", "SPT.SectorUID").andOn("S.IsActive", erpKnexRead.raw("1"));
      })
      .where("SPT.IsActive", 1)
      .orderBy("SPT.SectorUID", "asc")
      .orderBy("SPT.Price", "asc");
  }

  async getPlanModules(planUID: number, sectorUID: number): Promise<PlanModuleRow[]> {
    return erpKnexRead("Billing.SectorPlanModulesTbl as PM")
      .select(
        "M.ModuleUID", "M.DisplayName", "M.Icon",
        "M.IconBg", "M.IconColor", "M.Description"
      )
      .leftJoin("Modules.ModuleTbl as M", function () {
        this.on("M.ModuleUID", "PM.ModuleUID").andOn("M.IsDeleted", erpKnexRead.raw("0"));
      })
      .where("PM.SectorUID", sectorUID)
      .where("PM.PlanUID", planUID);
  }

  async getAllPlanModules(): Promise<AllPlanModuleRow[]> {
    return erpKnexRead("Billing.SectorPlanModulesTbl as PM")
      .select(
        "PM.PlanUID", "PM.SectorUID",
        "M.ModuleUID", "M.DisplayName", "M.Icon",
        "M.IconBg", "M.IconColor", "M.Description"
      )
      .leftJoin("Modules.ModuleTbl as M", function () {
        this.on("M.ModuleUID", "PM.ModuleUID").andOn("M.IsDeleted", erpKnexRead.raw("0"));
      });
  }
}
