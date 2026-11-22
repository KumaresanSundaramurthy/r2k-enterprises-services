import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Logger, Post, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { erpKnexWrite } from "../../config/erp-knex";

class PurgeOrgDto {
  @Allow() orgUID!: number;
}

class TestSeedDto {
  @Allow() orgUID!: number;
  @Allow() userUID!: number;
  @Allow() shortCode!: string;
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

  /* TEMPORARY — test signup seed SQL against an existing org. Remove after verification. */
  @Post("test-seed")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "TEMP: run signup seed SQL for an existing org — dev/staging only" })
  async testSeed(@Body() dto: TestSeedDto) {
    if (process.env.CI_ENV === "production") {
      throw new ForbiddenException("Not available in production.");
    }

    const logger = new Logger("TestSeed");
    const orgUID   = Number(dto.orgUID);
    const userUID  = Number(dto.userUID);
    const shortCode = String(dto.shortCode);

    const url = process.env.SIGNUP_SEED_URL;
    if (!url) return ciSuccess({ ran: false }, "SIGNUP_SEED_URL not set.");

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return ciSuccess({ ran: false }, `Fetch failed: HTTP ${res.status}`);

    const sql = (await res.text())
      .replace(/^﻿/, "")
      .replace(/\{\{OrgUid\}\}/g,       String(orgUID))
      .replace(/\{\{UserUid\}\}/g,      String(userUID))
      .replace(/\{\{OrgShortCode\}\}/g, `'${shortCode.replace(/'/g, "''")}'`)
      .replace(/\bINSERT\s+INTO\s+`(\w+)`/gi, "INSERT IGNORE INTO `Settings`.`$1`");

    const statements = sql.split(";").map((s) => s.trim()).filter((s) => /^INSERT\b/i.test(s));
    logger.log(`Found ${statements.length} INSERT statements`);

    const results: { sql: string; ok: boolean; error?: string }[] = [];
    for (const stmt of statements) {
      const preview = stmt.slice(0, 120).replace(/\s+/g, " ");
      try {
        await erpKnexWrite.raw(stmt);
        logger.log(`OK: ${preview}`);
        results.push({ sql: preview, ok: true });
      } catch (err) {
        const msg = (err as Error).message;
        logger.error(`FAILED [${msg}]: ${preview}`);
        results.push({ sql: preview, ok: false, error: msg });
      }
    }

    return ciSuccess({ orgUID, userUID, shortCode, results });
  }
}
