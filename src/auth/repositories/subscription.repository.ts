import { Injectable } from "@nestjs/common";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";

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
}
