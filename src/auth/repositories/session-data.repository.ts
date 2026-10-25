import { Injectable } from "@nestjs/common";
import { erpKnexRead } from "../../config/erp-knex";

export type DbRow = Record<string, string | null>;

// Queries behind CI3's Login_model::formatJWTPayload — the data that makes up a logged-in session.
@Injectable()
export class SessionDataRepository {
  async getOrgTimezone(orgUID: number): Promise<string | null> {
    const row = await erpKnexRead("Organisation.OrganisationTbl as O")
      .select("T.Timezone")
      .leftJoin("Global.TimezoneTbl as T", "T.TimezoneUID", "O.TimezoneUID")
      .where("O.OrgUID", orgUID)
      .first();
    return row?.Timezone ?? null;
  }

  async getRoleMainMenus(roleUID: number, orgUID: number): Promise<DbRow[]> {
    const query = erpKnexRead("UserRole.RoleMainMenusTbl as RMM")
      .select(
        "RMM.RoleMainMenuUID",
        "RMM.MainMenuUID",
        "MainMenu.Name as MainMenuName",
        "MainMenu.Icon as MainMenuIcons",
        "MainMenu.IsDirectLink",
        "MainMenu.DirectUrl",
        "RMM.Sorting",
        "RMM.CanView",
        "RMM.CanCreate",
        "RMM.CanEdit",
        "RMM.CanDelete"
      )
      .leftJoin("Modules.MainMenusTbl as MainMenu", "MainMenu.MainMenuUID", "RMM.MainMenuUID")
      .where({ "RMM.RoleUID": roleUID, "RMM.IsActive": 1, "RMM.IsDeleted": 0, "RMM.CanView": 1 })
      .orderBy("RMM.Sorting", "asc");
    // Scope to this org so shared global roles don't leak other orgs' menus
    if (orgUID > 0) query.where("MainMenu.OrgUID", orgUID);
    return query;
  }

  async getRoleSubMenus(roleUID: number, orgUID: number): Promise<DbRow[]> {
    const query = erpKnexRead("UserRole.RoleSubMenusTbl as RSM")
      .select(
        "RSM.RoleSubMenuUID",
        "Sub.MainMenuUID",
        "RSM.SubMenuUID",
        "Sub.Name as SubMenuName",
        "Sub.UrlPath",
        "Sub.ParentSubMenuUID",
        "Sub.IsParent",
        "Sub.Icon as SubMenuIcon",
        erpKnexRead.raw("COALESCE(`Mod`.ControllerName, '') as ControllerName"),
        "RSM.Sorting",
        "RSM.CanView",
        "RSM.CanCreate",
        "RSM.CanEdit",
        "RSM.CanDelete"
      )
      .join("Modules.SubMenusTbl as Sub", function () {
        this.on("Sub.SubMenuUID", "RSM.SubMenuUID").andOn("Sub.IsDeleted", erpKnexRead.raw("0"));
      })
      .leftJoin("Modules.ModuleTbl as Mod", function () {
        this.on("Mod.ModuleUID", "Sub.ModuleUID").andOn("Mod.IsDeleted", erpKnexRead.raw("0"));
      })
      .where({ "RSM.RoleUID": roleUID, "RSM.IsActive": 1, "RSM.IsDeleted": 0, "RSM.CanView": 1 })
      .orderBy("RSM.Sorting", "asc");
    if (orgUID > 0) query.where("Sub.OrgUID", orgUID);
    return query;
  }

  async getOrgGeneralSettings(orgUID: number): Promise<DbRow | null> {
    const row = await erpKnexRead("Settings.OrgSettingsTbl as GeneralSettg")
      .select(
        erpKnexRead.raw(
          [
            "GeneralSettg.CurrenySymbol",
            "GeneralSettg.RowLimit",
            "GeneralSettg.EnableStorage",
            "GeneralSettg.MandatoryStorage",
            "GeneralSettg.SerialNoDisplay",
            "GeneralSettg.QtyMaxLength",
            "GeneralSettg.FYStartMonth",
            "GeneralSettg.MaxShippingAddr",
            "GeneralSettg.DefaultSalutationUID",
            "COALESCE(GeneralSettg.FormDateFormat,'d-m-Y') AS FormDateFormat",
            "COALESCE(GeneralSettg.ListDateFormat,'d-m-Y') AS ListDateFormat",
            "COALESCE(GeneralSettg.PrintDateFormat,'d-m-Y') AS PrintDateFormat",
            "COALESCE(GeneralSettg.FormDateTimeFormat,'d-m-Y H:i') AS FormDateTimeFormat",
            "COALESCE(GeneralSettg.ListDateTimeFormat,'d-m-Y H:i') AS ListDateTimeFormat",
            "COALESCE(GeneralSettg.PrintDateTimeFormat,'d-m-Y H:i') AS PrintDateTimeFormat",
            "COALESCE(GeneralSettg.ShowStats, 1) AS ShowStats",
            "COALESCE(GeneralSettg.StatsDefaultOpen, 1) AS StatsDefaultOpen",
            "COALESCE(GeneralSettg.EmpCodePrefix,'EMP') AS EmpCodePrefix",
            "COALESCE(GeneralSettg.EmpCodeSeparator,'-') AS EmpCodeSeparator",
            "COALESCE(GeneralSettg.EmpCodeDigits, 4) AS EmpCodeDigits",
            "COALESCE(GeneralSettg.EnableAIAssistant,'No') AS EnableAIAssistant",
          ].join(", ")
        )
      )
      .where("GeneralSettg.OrgUID", orgUID)
      .first();
    return row ?? null;
  }

  async getModules(): Promise<DbRow[]> {
    return erpKnexRead("Modules.ModuleTbl as Module")
      .select(
        "Module.ModuleUID as ModuleUID",
        "Module.Name as Name",
        "Module.DisplayName as DisplayName",
        "Module.Description as Description",
        "Module.Icon as Icon",
        "Module.IconBg as IconBg",
        "Module.IconColor as IconColor",
        "Module.ControllerName as ControllerName"
      )
      .where({ "Module.IsDeleted": 0, "Module.IsActive": 1 });
  }

  async getProductSettings(orgUID: number): Promise<DbRow | null> {
    const row = await erpKnexRead("Settings.OrgProductSettingsTbl")
      .select("DefaultProductTypeUID", "DefaultDiscountTypeUID", "DefaultProductTaxUID", "DefaultTaxDetailUID")
      .where({ OrgUID: orgUID })
      .first();
    return row ?? null;
  }

  async getTransactionSettings(orgUID: number): Promise<DbRow | null> {
    const row = await erpKnexRead("Settings.TransactionSettingsTbl").select("*").where({ OrgUID: orgUID }).first();
    return row ?? null;
  }

  async getUserSignatures(userUID: number, orgUID: number): Promise<DbRow[]> {
    return erpKnexRead("Users.UserSignaturesTbl")
      .select("SignatureUID", "Label", "SignatureType", "ImagePath", "DrawData", "IsDefault")
      .where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy([
        { column: "IsDefault", order: "desc" },
        { column: "CreatedOn", order: "desc" },
      ]);
  }

  async getAttachmentSlotConfig(): Promise<DbRow[]> {
    return erpKnexRead("Modules.AttachmentSlotConfigTbl").select(
      "SlotKey",
      "IsEnabled",
      "MaxFiles",
      "MaxFileSizeMB",
      "MaxTotalSizeMB",
      "AllowMultiple",
      "AcceptedTypes"
    );
  }

  async getAccessibleBranches(userUID: number, orgUID: number): Promise<DbRow[]> {
    const result = await erpKnexRead.raw(
      `SELECT b.BranchUID, b.Name AS BranchName, b.BranchCode, BIT_COUNT(uba.IsDefault) AS IsDefault
         FROM Users.UserBranchAccessTbl uba
         JOIN Organisation.BranchesTbl b ON b.BranchUID = uba.BranchUID
        WHERE uba.UserUID = ? AND uba.OrgUID = ?
          AND uba.IsActive = 1 AND b.IsActive = 1 AND b.IsDeleted = 0
        ORDER BY uba.IsDefault DESC, b.Name ASC`,
      [userUID, orgUID]
    );
    return result[0] as DbRow[];
  }

  async getLatestOrgSubscription(orgUID: number): Promise<DbRow | null> {
    const row = await erpKnexRead("Billing.OrgSubscriptionTbl as os")
      .select(erpKnexRead.raw("COALESCE(sp.PlanName, 'Free Trial') AS PlanName"), "os.Status", "os.EndDate", "os.GracePeriodDays")
      .leftJoin("Billing.SectorPlanTbl as spt", "spt.SectorPlanUID", "os.SectorPlanUID")
      .leftJoin("Billing.SubscriptionPlansTbl as sp", "sp.PlanUID", "spt.PlanUID")
      .where("os.OrgUID", orgUID)
      .whereNotIn("os.Status", ["Cancelled"])
      .orderBy("os.StartDate", "desc")
      .first();
    return row ?? null;
  }

  async countActivePriceLists(orgUID: number): Promise<number> {
    const row = await erpKnexRead("Products.PriceListTbl")
      .count({ cnt: "*" })
      .where({ OrgUID: orgUID, Status: 1, IsDeleted: 0 })
      .first();
    return Number(row?.cnt ?? 0);
  }
}
