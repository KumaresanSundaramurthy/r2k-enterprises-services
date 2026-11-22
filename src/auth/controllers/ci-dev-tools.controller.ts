import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiServerGuard } from "../../common/guards/ci-server.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { erpKnexWrite } from "../../config/erp-knex";

class PurgeOrgDto {
  @Allow() orgUID!: number;
}

/** Dev / staging only — purge all rows for a given OrgUID across every table. Never available in production. */
@ApiTags("Dev Tools")
@ApiBearerAuth()
@UseGuards(CiServerGuard)
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

    await erpKnexWrite.raw("SET FOREIGN_KEY_CHECKS = 0");
    try {
      /* ── Tables with no OrgUID column — must delete via JOIN before auto-scan ── */

      /* RoleSubMenusTbl — joined through SubMenusTbl */
      const rsm = await erpKnexWrite.raw(
        `DELETE rsm FROM UserRole.RoleSubMenusTbl rsm
         INNER JOIN Modules.SubMenusTbl sm ON sm.SubMenuUID = rsm.SubMenuUID
         WHERE sm.OrgUID = ?`,
        [orgUID]
      );
      if (rsm[0]?.affectedRows > 0) deleted["UserRole.RoleSubMenusTbl"] = rsm[0].affectedRows;

      /* RoleMainMenusTbl — joined through MainMenusTbl */
      const rmm = await erpKnexWrite.raw(
        `DELETE rmm FROM UserRole.RoleMainMenusTbl rmm
         INNER JOIN Modules.MainMenusTbl mm ON mm.MainMenuUID = rmm.MainMenuUID
         WHERE mm.OrgUID = ?`,
        [orgUID]
      );
      if (rmm[0]?.affectedRows > 0) deleted["UserRole.RoleMainMenusTbl"] = rmm[0].affectedRows;

      /* PasswordHistoryTbl — joined through UserTbl */
      const ph = await erpKnexWrite.raw(
        `DELETE ph FROM Users.PasswordHistoryTbl ph
         INNER JOIN Users.UserTbl u ON u.UserUID = ph.UserUID
         WHERE u.OrgUID = ?`,
        [orgUID]
      );
      if (ph[0]?.affectedRows > 0) deleted["Users.PasswordHistoryTbl"] = ph[0].affectedRows;

      /* ── Auto-scan: all tables that directly have OrgUID column ── */
      const tables: { TABLE_SCHEMA: string; TABLE_NAME: string }[] = await erpKnexWrite
        .select("TABLE_SCHEMA", "TABLE_NAME")
        .from("information_schema.COLUMNS")
        .where("COLUMN_NAME", "OrgUID")
        .whereNotIn("TABLE_SCHEMA", ["information_schema", "performance_schema", "mysql", "sys"]);

      for (const { TABLE_SCHEMA, TABLE_NAME } of tables) {
        const count = await erpKnexWrite(`${TABLE_SCHEMA}.${TABLE_NAME}`)
          .where("OrgUID", orgUID)
          .delete();
        if (count > 0) deleted[`${TABLE_SCHEMA}.${TABLE_NAME}`] = count;
      }
    } finally {
      await erpKnexWrite.raw("SET FOREIGN_KEY_CHECKS = 1");
    }

    return ciSuccess({ orgUID, deleted }, `Purged OrgUID ${orgUID} from ${Object.keys(deleted).length} table(s).`);
  }
}
