import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { Filter, Row } from "./hrms-common";

export type MasterKind = "department" | "designation";

// DepartmentTbl / DesignationTbl: the org's own rows plus the system rows (OrgUID 0) every org shares
const MASTER = {
  department: { table: "Organisation.DepartmentTbl", uid: "DepartmentUID", name: "DepartmentName", orgOrder: "desc" },
  designation: { table: "Organisation.DesignationTbl", uid: "DesignationUID", name: "DesignationName", orgOrder: "asc" },
} as const;

/** Users_model's department / designation / holiday / employee reads and their writes. */
@Injectable()
export class HrmsMastersRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getDepartmentListPaginated / getDesignationListPaginated
  async masterPage(kind: MasterKind, orgUID: number, filter: Filter, limit: number, offset: number): Promise<{ rows: Row[]; total: number }> {
    const m = MASTER[kind];
    const base = () => {
      const qb = this.read(m.table).where((w) => w.where("OrgUID", orgUID).orWhere("OrgUID", 0)).where("IsDeleted", 0);
      if (filter.SearchAllData) this.whereAnyLike(qb, [m.name, "Description"], filter.SearchAllData);
      return qb;
    };
    const [rows, count] = await Promise.all([
      base()
        .select(`${m.uid} as TablePrimaryUID`, m.uid, m.name, "Description", "OrgUID", "IsActive")
        .orderBy("OrgUID", m.orgOrder)
        .orderBy(m.name, "asc")
        .limit(limit)
        .offset(offset),
      base().count({ cnt: "*" }).first(),
    ]);
    return { rows: (rows as Row[]).map(HrmsMastersRepository.bits), total: Number(count?.cnt ?? 0) };
  }

  // getDepartmentList / getDesignationList — active rows for dropdowns
  masterList(kind: MasterKind, orgUID: number): Promise<Row[]> {
    const m = MASTER[kind];
    return this.read(m.table)
      .select(m.uid, m.name)
      .where((w) => w.where("OrgUID", orgUID).orWhere("OrgUID", 0))
      .where({ IsDeleted: 0, IsActive: 1 })
      .orderBy(m.name, "asc");
  }

  async masterFind(kind: MasterKind, uid: number): Promise<Row | null> {
    const m = MASTER[kind];
    const row = await this.read(m.table).select(m.uid, "OrgUID").where({ [m.uid]: uid, IsDeleted: 0 }).first();
    return (row as Row | undefined) ?? null;
  }

  async masterInsert(kind: MasterKind, data: Row): Promise<number> {
    const [id] = await this.db.write(MASTER[kind].table).insert(data);
    return Number(id);
  }

  // Scoped to the org's own rows: system rows (OrgUID 0) are never changed here
  masterUpdate(kind: MasterKind, orgUID: number, uid: number, data: Row): Promise<number> {
    const m = MASTER[kind];
    return this.db.write(m.table).where({ [m.uid]: uid, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  // getHolidayListPaginated — Year (and Month) as an index-friendly date range
  async holidayPage(orgUID: number, filter: Filter, limit: number, offset: number): Promise<{ rows: Row[]; total: number }> {
    const year = parseInt(filter.Year ?? "", 10);
    const month = parseInt(filter.Month ?? "", 10);
    let range: [string, string] | null = null;
    if (year > 0) {
      if (month >= 1 && month <= 12) {
        const mm = String(month).padStart(2, "0");
        const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        range = [`${year}-${mm}-01`, `${year}-${mm}-${lastDay}`];
      } else {
        range = [`${year}-01-01`, `${year}-12-31`];
      }
    }
    const base = () => {
      const qb = this.read("Organisation.HolidayTbl").where({ OrgUID: orgUID, IsDeleted: 0 });
      if (range) qb.whereBetween("HolidayDate", range);
      if (filter.SearchAllData) this.whereAnyLike(qb, ["HolidayName", "Description"], filter.SearchAllData);
      return qb;
    };
    const [rows, count] = await Promise.all([
      base()
        .select("HolidayUID as TablePrimaryUID", "HolidayUID", "HolidayName", this.read.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", ["HolidayDate", "HolidayDate"]), "Description", "IsOptional", "IsActive", "OrgUID")
        .orderBy("HolidayDate", "asc")
        .limit(limit)
        .offset(offset),
      base().count({ cnt: "*" }).first(),
    ]);
    return { rows: (rows as Row[]).map(HrmsMastersRepository.bits), total: Number(count?.cnt ?? 0) };
  }

  async holidayInsert(data: Row): Promise<number> {
    const [id] = await this.db.write("Organisation.HolidayTbl").insert(data);
    return Number(id);
  }

  holidayUpdate(orgUID: number, uid: number, data: Row): Promise<number> {
    return this.db.write("Organisation.HolidayTbl").where({ HolidayUID: uid, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  // getEmployeeDropdownList — active, not terminated staff with their salary set-up
  employees(orgUID: number, trx?: Knex.Transaction): Promise<Row[]> {
    return (trx ?? this.read)("Users.UserTbl")
      .select(
        "UserUID as EmployeeUID",
        "EmployeeCode",
        this.read.raw("CONCAT(??, ' ', ??) AS ??", ["FirstName", "LastName", "EmployeeName"]),
        "HasLoginAccess",
        "SalaryType",
        "BasicSalary",
        "Allowances",
        "Incentives",
        "FixedDeductions"
      )
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .whereNot("EmployeeStatus", "Terminated")
      .orderBy("FirstName", "asc")
      .then((rows: Row[]) => rows.map(HrmsMastersRepository.bits));
  }

  // Which of these users are staff of the org (any status, not deleted)
  async orgEmployeeUIDs(orgUID: number, uids: number[]): Promise<Set<number>> {
    if (uids.length === 0) return new Set();
    const rows = await this.read("Users.UserTbl").select("UserUID").where({ OrgUID: orgUID, IsDeleted: 0 }).whereIn("UserUID", uids);
    return new Set(rows.map((r: Row) => Number(r.UserUID)));
  }

  // BIT columns come back as Buffers → 0 / 1
  static bits(row: Row): Row {
    for (const [key, value] of Object.entries(row)) {
      if (Buffer.isBuffer(value)) row[key] = value.length > 0 ? value[0] : 0;
    }
    return row;
  }
}
