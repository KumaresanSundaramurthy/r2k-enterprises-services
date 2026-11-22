import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { erpKnexWrite } from "../../config/erp-knex";

class PurgeOrgDto {
  @Allow() orgUID!: number;
}

/** Dev / staging only — purge all rows for a given OrgUID across every table. Never available in production. */
@ApiTags("Dev Tools")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/dev")
export class CiDevToolsController {

  @Post("purge-org")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete all rows for OrgUID from every table — dev/staging only" })
  async purgeOrg(@Body() dto: PurgeOrgDto) {
    if (process.env.CI_ENV === "production") {
      throw new ForbiddenException("Not available in production.");
    }

    const orgUID = Number(dto.orgUID);
    if (!orgUID || orgUID <= 0) {
      return ciSuccess({ deleted: {} }, "Invalid OrgUID.");
    }

    const deleted: Record<string, number> = {};

    /* raw() needs a default DB on the connection even when every table is schema-qualified */
    await erpKnexWrite.raw("USE Organisation");
    await erpKnexWrite.raw("SET FOREIGN_KEY_CHECKS = 0");
    try {
      const run = async (label: string, sql: string) => {
        const [res] = await erpKnexWrite.raw(sql, [orgUID]);
        if (res?.affectedRows > 0) deleted[label] = res.affectedRows;
      };

      /* Order matches your SQL — child tables first, OrganisationTbl last */
      await run("UserRole.RoleSubMenusTbl",
        `DELETE rsm FROM UserRole.RoleSubMenusTbl rsm
         INNER JOIN Modules.SubMenusTbl sm ON sm.SubMenuUID = rsm.SubMenuUID
         WHERE sm.OrgUID = ?`);

      await run("UserRole.RoleMainMenusTbl",
        `DELETE rmm FROM UserRole.RoleMainMenusTbl rmm
         INNER JOIN Modules.MainMenusTbl mm ON mm.MainMenuUID = rmm.MainMenuUID
         WHERE mm.OrgUID = ?`);

      await run("Modules.SubMenusTbl",
        `DELETE FROM Modules.SubMenusTbl WHERE OrgUID = ?`);

      await run("Modules.MainMenusTbl",
        `DELETE FROM Modules.MainMenusTbl WHERE OrgUID = ?`);

      await run("Users.UserBranchAccessTbl",
        `DELETE FROM Users.UserBranchAccessTbl WHERE OrgUID = ?`);

      await run("Users.PasswordHistoryTbl",
        `DELETE ph FROM Users.PasswordHistoryTbl ph
         INNER JOIN Users.UserTbl u ON u.UserUID = ph.UserUID
         WHERE u.OrgUID = ?`);

      await run("Users.UserTbl",
        `DELETE FROM Users.UserTbl WHERE OrgUID = ?`);

      await run("UserRole.RolesTbl",
        `DELETE FROM UserRole.RolesTbl WHERE OrgUID = ?`);

      await run("Settings.OrgProductSettingsTbl",
        `DELETE FROM Settings.OrgProductSettingsTbl WHERE OrgUID = ?`);

      await run("Settings.OrgSettingsTbl",
        `DELETE FROM Settings.OrgSettingsTbl WHERE OrgUID = ?`);

      await run("Settings.PrintThemeConfigTbl",
        `DELETE FROM Settings.PrintThemeConfigTbl WHERE OrgUID = ?`);

      await run("Settings.ThermalPrintConfigTbl",
        `DELETE FROM Settings.ThermalPrintConfigTbl WHERE OrgUID = ?`);

      await run("Settings.MessageTemplatesTbl",
        `DELETE FROM Settings.MessageTemplatesTbl WHERE OrgUID = ?`);

      await run("Settings.TransactionPrefixTbl",
        `DELETE FROM Settings.TransactionPrefixTbl WHERE OrgUID = ?`);

      await run("Settings.TransactionSettingsTbl",
        `DELETE FROM Settings.TransactionSettingsTbl WHERE OrgUID = ?`);

      await run("Billing.SubscriptionOrdersTbl",
        `DELETE FROM Billing.SubscriptionOrdersTbl WHERE OrgUID = ?`);

      await run("Billing.OrgSubscriptionTbl",
        `DELETE FROM Billing.OrgSubscriptionTbl WHERE OrgUID = ?`);

      await run("Organisation.BranchesTbl",
        `DELETE FROM Organisation.BranchesTbl WHERE OrgUID = ?`);

      await run("Organisation.OrganisationTbl",
        `DELETE FROM Organisation.OrganisationTbl WHERE OrgUID = ?`);
    } finally {
      await erpKnexWrite.raw("SET FOREIGN_KEY_CHECKS = 1");
    }

    return ciSuccess({ orgUID, deleted }, `Purged OrgUID ${orgUID} from ${Object.keys(deleted).length} table(s).`);
  }
}
