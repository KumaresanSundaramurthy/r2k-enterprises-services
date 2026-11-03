import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

// Filter of the staff list (CI3 Users_model::_applyFilters)
export interface UserListFilter {
  EmpStatus?: string;
  LoginAccess?: string | number;
  DeptUIDs?: (string | number)[] | string | number;
  Name?: string;
}

const USERS = "Users.UserTbl";

// CI3 Users_model (staff list, employee codes, branch access).
@Injectable()
export class UsersRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getUsersList — newest first, with role, department, designation and who last changed the record
  async list(orgUID: number, filter: UserListFilter, limit: number, offset: number): Promise<Row[]> {
    const qb = this.read(`${USERS} as u`)
      .select(
        "u.UserUID", "u.EmployeeCode", "u.FirstName", "u.LastName", "u.UserName",
        "u.EmailAddress", "u.MobileNumber",
        "u.HasLoginAccess",
        "u.RoleUID", "r.Name as RoleName",
        "u.DepartmentUID", "d.DepartmentName",
        "u.DesignationUID", "ds.DesignationName",
        "u.DateOfJoining", "u.EmployeeStatus",
        "u.SalaryType", "u.BasicSalary",
        "u.IsActive", "u.IsLocked", "u.LastLoginOn",
        "u.UpdatedOn",
        this.read.raw("CONCAT(IFNULL(ub.FirstName,''), ' ', IFNULL(ub.LastName,'')) AS UpdatedBy")
      )
      .leftJoin("UserRole.RolesTbl as r", (on) => on.on("r.RoleUID", "u.RoleUID").andOnVal("r.IsDeleted", "=", 0))
      .leftJoin("Organisation.DepartmentTbl as d", (on) => on.on("d.DepartmentUID", "u.DepartmentUID").andOnVal("d.IsDeleted", "=", 0))
      .leftJoin("Organisation.DesignationTbl as ds", (on) => on.on("ds.DesignationUID", "u.DesignationUID").andOnVal("ds.IsDeleted", "=", 0))
      .leftJoin(`${USERS} as ub`, "ub.UserUID", "u.UpdatedBy")
      .where({ "u.OrgUID": orgUID, "u.IsDeleted": 0 })
      .orderBy("u.UserUID", "desc")
      .limit(limit)
      .offset(offset);
    this.applyFilter(qb, filter);
    return qb;
  }

  async count(orgUID: number, filter: UserListFilter): Promise<number> {
    const qb = this.read(`${USERS} as u`).count({ total: "*" }).where({ "u.OrgUID": orgUID, "u.IsDeleted": 0 });
    this.applyFilter(qb, filter);
    return Number((await qb.first())?.total ?? 0);
  }

  // getUserStats — header cards
  async stats(orgUID: number): Promise<Row | null> {
    const row = await this.read(USERS)
      .select(
        // Aliases are quoted: TERMINATED is a reserved word in MySQL 8
        this.read.raw(`COUNT(*) AS ??,
          SUM(EmployeeStatus = 'Active') AS ??,
          SUM(EmployeeStatus = 'Resigned') AS ??,
          SUM(EmployeeStatus = 'Terminated') AS ??,
          SUM(EmployeeStatus = 'OnLeave') AS ??,
          SUM(HasLoginAccess = 1) AS ??`, ["Total", "Active", "Resigned", "Terminated", "OnLeave", "LoginUsers"])
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // Employee-code format from the organisation's settings (CI3 _parseEmpCodeFormat)
  async employeeCodeFormat(orgUID: number): Promise<{ prefix: string; separator: string; digits: number }> {
    const fmt = await this.read("Settings.OrgSettingsTbl").select("EmpCodePrefix", "EmpCodeSeparator", "EmpCodeDigits").where({ OrgUID: orgUID }).first();
    let prefix = String(fmt?.EmpCodePrefix ?? "EMP").trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(prefix)) prefix = "EMP";
    let separator = fmt?.EmpCodeSeparator ?? "-";
    if (separator === "none") separator = "";
    if (!["-", "/", ""].includes(separator)) separator = "-";
    let digits = Number(fmt?.EmpCodeDigits ?? 4);
    if (digits < 3 || digits > 6) digits = 4;
    return { prefix, separator, digits };
  }

  // getNextEmployeeCode — the counter's next value (preview only; nothing is claimed)
  async lastEmployeeNumber(orgUID: number): Promise<number> {
    const row = await this.read("Settings.OrgCreditSettingsTbl").select("EmpCodeLastNum").where({ OrgUID: orgUID }).first();
    return Number(row?.EmpCodeLastNum ?? 0);
  }

  /**
   * claimNextEmployeeCode — increments the counter and returns this request's number (LAST_INSERT_ID(expr) is
   * per connection, so concurrent saves never get the same number). Without a counter row: highest code + 1.
   */
  async claimEmployeeNumber(orgUID: number, trx: Knex.Transaction): Promise<number> {
    const affected = await trx("Settings.OrgCreditSettingsTbl")
      .where({ OrgUID: orgUID })
      .update({ EmpCodeLastNum: trx.raw("LAST_INSERT_ID(EmpCodeLastNum + 1)"), UpdatedAt: trx.fn.now() });
    if (affected > 0) {
      const result = await trx.raw("SELECT LAST_INSERT_ID() AS ClaimedNum");
      return Number(result[0][0]?.ClaimedNum ?? 1);
    }
    const row = await trx(USERS)
      .select(trx.raw(`COALESCE(MAX(CAST(REGEXP_REPLACE(EmployeeCode, '[^0-9]', '') AS UNSIGNED)), 0) + 1 AS NextNum`))
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return Math.max(1, Number(row?.NextNum ?? 1));
  }

  // getEmployeeDropdownList — staff for attendance / payroll (terminated staff left out)
  async employeeDropdown(orgUID: number): Promise<Row[]> {
    return this.read(USERS)
      .select(
        "UserUID as EmployeeUID",
        "EmployeeCode",
        this.read.raw("CONCAT(FirstName, ' ', LastName) AS EmployeeName"),
        "HasLoginAccess", "SalaryType", "BasicSalary", "Allowances", "Incentives", "FixedDeductions"
      )
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .whereNot("EmployeeStatus", "Terminated")
      .orderBy("FirstName", "asc");
  }

  // getOrgUsersForCache — active users who can log in
  async loginUsers(orgUID: number): Promise<Row[]> {
    return this.read(USERS)
      .select("UserUID", "FirstName", "LastName", this.read.raw("CONCAT(FirstName, ' ', LastName) AS FullName"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1, HasLoginAccess: 1 })
      .orderBy("FirstName", "asc");
  }

  // getUserBranchAccess
  async branchAccess(orgUID: number, userUID: number): Promise<Row[]> {
    return this.read("Users.UserBranchAccessTbl")
      .select("BranchUID", this.read.raw("BIT_COUNT(IsDefault) AS IsDefault"))
      .where({ UserUID: userUID, OrgUID: orgUID, IsActive: 1 });
  }

  // syncUserBranchAccess — replaces the user's branch list
  async replaceBranchAccess(trx: Knex.Transaction, orgUID: number, userUID: number, branches: { BranchUID?: unknown; IsDefault?: unknown }[]): Promise<void> {
    await trx("Users.UserBranchAccessTbl").where({ UserUID: userUID, OrgUID: orgUID }).delete();
    const rows = branches
      .filter((branch) => Number(branch.BranchUID) > 0)
      .map((branch) => ({ UserUID: userUID, OrgUID: orgUID, BranchUID: Number(branch.BranchUID), IsDefault: Number(branch.IsDefault ?? 0) ? 1 : 0, IsActive: 1 }));
    if (rows.length > 0) await trx("Users.UserBranchAccessTbl").insert(rows);
  }

  async insertUser(trx: Knex.Transaction, data: Row): Promise<number> {
    const [id] = await trx(USERS).insert(data);
    return Number(id);
  }

  async updateUser(orgUID: number, userUID: number, data: Row, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)(USERS).where({ UserUID: userUID, OrgUID: orgUID }).update(data);
  }

  async roleName(orgUID: number, userUID: number): Promise<string | null> {
    const row = await this.read(`${USERS} as u`)
      .select("r.Name as RoleName")
      .leftJoin("UserRole.RolesTbl as r", "r.RoleUID", "u.RoleUID")
      .where({ "u.UserUID": userUID, "u.OrgUID": orgUID, "u.IsDeleted": 0 })
      .first();
    return row?.RoleName ?? null;
  }

  private applyFilter(qb: Knex.QueryBuilder, filter: UserListFilter): void {
    if (filter.EmpStatus && filter.EmpStatus !== "All") qb.where("u.EmployeeStatus", filter.EmpStatus);
    if (filter.LoginAccess !== undefined && filter.LoginAccess !== "") qb.where("u.HasLoginAccess", Number(filter.LoginAccess) || 0);
    const departments = ([] as unknown[]).concat(filter.DeptUIDs ?? []).map(Number).filter((uid) => uid > 0);
    if (departments.length > 0) qb.whereIn("u.DepartmentUID", departments);
    if (filter.Name) this.whereAnyLike(qb, ["u.FirstName", "u.LastName", "u.UserName", "u.EmailAddress", "u.EmployeeCode", "u.MobileNumber"], filter.Name);
  }
}
