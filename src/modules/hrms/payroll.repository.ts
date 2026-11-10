import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { Filter, Row } from "./hrms-common";

// PayrollLineTbl keeps the employee in UserUID; CI3 read and wrote a non-existent EmployeeUID column, so every
// payroll line insert and every payroll-line / payslip read failed.
const LINE_COLUMNS = [
  "PL.PayrollLineUID",
  "PL.PayrollUID",
  "PL.OrgUID",
  "PL.UserUID as EmployeeUID",
  "PL.SalaryType",
  "PL.BasicSalary",
  "PL.Allowances",
  "PL.Incentives",
  "PL.GrossSalary",
  "PL.WorkingDays",
  "PL.PresentDays",
  "PL.AbsentDays",
  "PL.HoursWorked",
  "PL.SalaryDeduction",
  "PL.FixedDeductions",
  "PL.AdvanceRecovery",
  "PL.NetSalary",
];

/** Payroll_model: payroll runs, their lines and payslips (one line = one employee's payslip). */
@Injectable()
export class PayrollRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  private employeeJoins(qb: Knex.QueryBuilder, alias = "PL"): Knex.QueryBuilder {
    const k = this.read;
    return qb
      .join("Users.UserTbl as U", (on) => on.on("U.UserUID", `${alias}.UserUID`).andOnVal("U.IsDeleted", "=", 0))
      .leftJoin("Organisation.DepartmentTbl as D", (on) => on.on("D.DepartmentUID", "U.DepartmentUID").andOnVal("D.IsDeleted", "=", 0))
      .leftJoin("Organisation.DesignationTbl as DS", (on) => on.on("DS.DesignationUID", "U.DesignationUID").andOnVal("DS.IsDeleted", "=", 0))
      .select(k.raw("CONCAT(??, ' ', ??) AS ??", ["U.FirstName", "U.LastName", "EmployeeName"]), "U.EmployeeCode", "D.DepartmentName", "DS.DesignationName");
  }

  // getPayrollListPaginated (Status, or PayrollStatus as the CI3 JS sends it, and Year)
  async payrollPage(orgUID: number, filter: Filter, limit: number, offset: number): Promise<{ rows: Row[]; total: number }> {
    const status = filter.Status || filter.PayrollStatus;
    const base = () => {
      const qb = this.read("Transaction.PayrollTbl as P").where({ "P.OrgUID": orgUID, "P.IsDeleted": 0 });
      if (status && status !== "All") qb.where("P.PayrollStatus", status);
      if (Number(filter.Year) > 0) qb.where("P.PayrollYear", Number(filter.Year));
      return qb;
    };
    const [rows, count] = await Promise.all([
      base()
        .select(
          "P.PayrollUID as TablePrimaryUID",
          "P.PayrollMonth",
          "P.PayrollYear",
          "P.PayrollStatus",
          "P.TotalEmployees",
          "P.TotalGrossSalary",
          "P.TotalDeductions",
          "P.TotalNetSalary",
          "P.ProcessedOn",
          "P.Notes",
          "P.CreatedOn"
        )
        .orderBy("P.PayrollYear", "desc")
        .orderBy("P.PayrollMonth", "desc")
        .limit(limit)
        .offset(offset),
      base().count({ cnt: "*" }).first(),
    ]);
    return { rows: rows as Row[], total: Number(count?.cnt ?? 0) };
  }

  // getPayrollStats
  async payrollStats(orgUID: number): Promise<Row> {
    const row = await this.read("Transaction.PayrollTbl")
      .select(
        this.read.raw(`COUNT(*) AS Total,
          IFNULL(SUM(CASE WHEN PayrollStatus = 'Draft' THEN 1 ELSE 0 END), 0) AS Draft,
          IFNULL(SUM(CASE WHEN PayrollStatus = 'Processed' THEN 1 ELSE 0 END), 0) AS Processed,
          IFNULL(SUM(CASE WHEN PayrollStatus = 'Paid' THEN 1 ELSE 0 END), 0) AS Paid,
          IFNULL(SUM(CASE WHEN PayrollStatus = 'Paid' THEN TotalNetSalary ELSE 0 END), 0) AS TotalPaid`)
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? {};
  }

  // getPayrollByUID
  async payroll(orgUID: number, payrollUID: number): Promise<Row | null> {
    const row = await this.read("Transaction.PayrollTbl")
      .select(
        "PayrollUID",
        "OrgUID",
        "BranchUID",
        "PayrollMonth",
        "PayrollYear",
        "PayrollStatus",
        "TotalEmployees",
        "TotalGrossSalary",
        "TotalDeductions",
        "TotalNetSalary",
        "Notes",
        "ProcessedOn",
        "CreatedOn",
        "UpdatedOn"
      )
      .where({ PayrollUID: payrollUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? null;
  }

  /**
   * getPayrollExists — the run of the org / branch / month, deleted ones included: the unique key covers deleted
   * rows, so a month whose payroll was deleted is processed again on that same row (CI3 failed to insert it).
   */
  async payrollOfMonth(orgUID: number, branchUID: number, month: number, year: number, trx?: Knex.Transaction): Promise<Row | null> {
    const qb = (trx ?? this.read)("Transaction.PayrollTbl")
      .select("PayrollUID", "PayrollStatus", this.read.raw("CAST(?? AS UNSIGNED) AS ??", ["IsDeleted", "IsDeleted"]))
      .where({ OrgUID: orgUID, BranchUID: branchUID, PayrollMonth: month, PayrollYear: year });
    if (trx) qb.forUpdate();
    const row = await qb.first();
    return (row as Row | undefined) ?? null;
  }

  // getPayrollLines
  payrollLines(orgUID: number, payrollUID: number, trx?: Knex.Transaction): Promise<Row[]> {
    const qb = (trx ?? this.read)("Transaction.PayrollLineTbl as PL").select(LINE_COLUMNS).where({ "PL.PayrollUID": payrollUID, "PL.OrgUID": orgUID, "PL.IsDeleted": 0 });
    return this.employeeJoins(qb).orderBy("EmployeeName", "asc");
  }

  async insertPayroll(trx: Knex.Transaction, data: Row): Promise<number> {
    const [id] = await trx("Transaction.PayrollTbl").insert(data);
    return Number(id);
  }

  updatePayroll(orgUID: number, payrollUID: number, data: Row, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? this.db.write)("Transaction.PayrollTbl").where({ PayrollUID: payrollUID, OrgUID: orgUID }).update(data);
  }

  // Lines are unique per payroll + employee, deleted rows included: a reprocessed employee's row is overwritten
  async upsertLine(trx: Knex.Transaction, row: Row): Promise<void> {
    const merge = Object.keys(row).filter((key) => !["PayrollUID", "UserUID", "CreatedBy"].includes(key));
    await trx("Transaction.PayrollLineTbl").insert({ ...row, IsDeleted: 0 }).onConflict(["PayrollUID", "UserUID"]).merge([...merge, "IsDeleted"]);
  }

  deleteLines(trx: Knex.Transaction, orgUID: number, payrollUID: number, userUID: number): Promise<number> {
    return trx("Transaction.PayrollLineTbl").where({ PayrollUID: payrollUID, OrgUID: orgUID, IsDeleted: 0 }).update({ IsDeleted: 1, UpdatedBy: userUID });
  }

  // getPayslipListPaginated
  async payslipPage(orgUID: number, filter: Filter, limit: number, offset: number): Promise<{ rows: Row[]; total: number }> {
    const base = () => {
      const qb = this.read("Transaction.PayrollLineTbl as PL")
        .join("Transaction.PayrollTbl as P", (on) => on.on("P.PayrollUID", "PL.PayrollUID").andOnVal("P.IsDeleted", "=", 0))
        .where({ "P.OrgUID": orgUID, "PL.IsDeleted": 0 });
      if (Number(filter.EmployeeUID) > 0) qb.where("PL.UserUID", Number(filter.EmployeeUID));
      if (Number(filter.Year) > 0) qb.where("P.PayrollYear", Number(filter.Year));
      if (Number(filter.Month) > 0) qb.where("P.PayrollMonth", Number(filter.Month));
      return qb;
    };
    const list = base().select(
      "PL.PayrollLineUID as TablePrimaryUID",
      "PL.PayrollUID",
      "P.PayrollMonth",
      "P.PayrollYear",
      "P.PayrollStatus",
      "PL.UserUID as EmployeeUID",
      "PL.SalaryType",
      "PL.GrossSalary",
      "PL.NetSalary",
      "PL.PresentDays",
      "PL.AbsentDays",
      "PL.WorkingDays",
      "PL.AdvanceRecovery",
      "PL.SalaryDeduction"
    );
    const [rows, count] = await Promise.all([
      this.employeeJoins(list).orderBy("P.PayrollYear", "desc").orderBy("P.PayrollMonth", "desc").orderBy("EmployeeName", "asc").limit(limit).offset(offset),
      // The employee join is part of the count, as in the list (CI3 counted lines of deleted users too)
      base().join("Users.UserTbl as U", (on) => on.on("U.UserUID", "PL.UserUID").andOnVal("U.IsDeleted", "=", 0)).count({ cnt: "*" }).first(),
    ]);
    return { rows: rows as Row[], total: Number(count?.cnt ?? 0) };
  }

  // getPayslipDetail
  async payslip(orgUID: number, payrollLineUID: number): Promise<Row | null> {
    const k = this.read;
    const qb = k("Transaction.PayrollLineTbl as PL")
      .select(LINE_COLUMNS)
      .select("P.PayrollMonth", "P.PayrollYear", "P.PayrollStatus", "U.MobileNumber as Mobile", "U.EmailAddress as Email", k.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", ["U.DateOfJoining", "DateOfJoining"]))
      .join("Transaction.PayrollTbl as P", (on) => on.on("P.PayrollUID", "PL.PayrollUID").andOnVal("P.IsDeleted", "=", 0))
      .where({ "PL.PayrollLineUID": payrollLineUID, "P.OrgUID": orgUID, "PL.IsDeleted": 0 });
    const row = await this.employeeJoins(qb).first();
    return (row as Row | undefined) ?? null;
  }
}
