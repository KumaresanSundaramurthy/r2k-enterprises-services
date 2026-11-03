import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { Row } from "./settings-lookups.repository";

export const MESSAGE_TEMPLATES = "Settings.MessageTemplatesTbl";
export const THERMAL_CONFIGS = "Settings.ThermalPrintConfigTbl";
export const PREFIXES = "Settings.TransactionPrefixTbl";

const updatedByName = (alias: string, nullSafe: boolean) =>
  nullSafe ? `CONCAT(${alias}.FirstName, ' ', IFNULL(${alias}.LastName,'')) AS UpdatedByName` : `CONCAT(${alias}.FirstName, ' ', ${alias}.LastName) AS UpdatedByName`;

/**
 * Per-organisation document settings kept one row per module: message templates, thermal print configs and
 * number prefixes (CI3 Organisation_model). Every write is limited to the organisation.
 */
@Injectable()
export class PrintConfigRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getMessageTemplates — with the module name and who last changed it
  async messageTemplates(orgUID: number): Promise<Row[]> {
    return this.read(`${MESSAGE_TEMPLATES} as T`)
      .select("T.*", "M.Name as ModuleName", this.read.raw(updatedByName("U", false)))
      .leftJoin("Modules.ModuleTbl as M", "M.ModuleUID", "T.ModuleUID")
      .leftJoin("Users.UserTbl as U", "U.UserUID", "T.UpdatedBy")
      .where({ "T.OrgUID": orgUID, "T.IsDeleted": 0 })
      .orderBy([
        { column: "T.ModuleUID", order: "asc" },
        { column: "T.Channel", order: "asc" },
      ]);
  }

  // getThermalPrintConfigList
  async thermalConfigs(orgUID: number): Promise<Row[]> {
    return this.read(`${THERMAL_CONFIGS} as TC`)
      .select("TC.*", "M.Name as ModuleName", this.read.raw(updatedByName("U", false)))
      .leftJoin("Modules.ModuleTbl as M", "M.ModuleUID", "TC.ModuleUID")
      .leftJoin("Users.UserTbl as U", "U.UserUID", "TC.UpdatedBy")
      .where({ "TC.OrgUID": orgUID, "TC.IsDeleted": 0 })
      .orderBy("TC.ThermalConfigUID", "asc");
  }

  // getPrefixConfigList — defaults first, then in menu order
  async prefixes(orgUID: number): Promise<Row[]> {
    return this.read(`${PREFIXES} as P`)
      .select("P.*", "M.Name as ModuleName", this.read.raw(updatedByName("U", true)))
      .leftJoin("Modules.ModuleTbl as M", (on) => {
        on.on("M.ModuleUID", "P.ModuleUID").andOnVal("M.IsDeleted", "=", 0);
      })
      .leftJoin("Users.UserTbl as U", "U.UserUID", "P.UpdatedBy")
      .where({ "P.OrgUID": orgUID, "P.IsDeleted": 0 })
      .orderBy([
        { column: "P.IsDefault", order: "desc" },
        { column: "M.Sorting", order: "asc" },
        { column: "P.PrefixUID", order: "asc" },
      ]);
  }

  // getPrefixByUID
  async prefix(orgUID: number, prefixUID: number): Promise<Row | null> {
    const row = await this.read(`${PREFIXES} as P`)
      .select("P.*", "M.Name as ModuleName")
      .leftJoin("Modules.ModuleTbl as M", (on) => {
        on.on("M.ModuleUID", "P.ModuleUID").andOnVal("M.IsDeleted", "=", 0);
      })
      .where({ "P.PrefixUID": prefixUID, "P.OrgUID": orgUID, "P.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // A row of one of the tables, by its primary key, within the organisation (not deleted)
  async findOne(table: string, where: Row, orgUID: number): Promise<Row | null> {
    const row = await this.read(table).select("*").where({ ...where, OrgUID: orgUID, IsDeleted: 0 }).first();
    return row ?? null;
  }

  async count(table: string, where: Row, orgUID: number): Promise<number> {
    const row = await this.read(table).count({ total: "*" }).where({ ...where, OrgUID: orgUID, IsDeleted: 0 }).first();
    return Number(row?.total ?? 0);
  }

  async insert(table: string, data: Row, trx?: Knex.Transaction): Promise<number> {
    const [id] = await this.writer(trx)(table).insert(data);
    return Number(id);
  }

  async update(table: string, where: Row, orgUID: number, data: Row, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)(table).where({ ...where, OrgUID: orgUID }).update(data);
  }
}
