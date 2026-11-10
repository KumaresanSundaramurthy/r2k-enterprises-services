import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { Filter, Row } from "./hrms-common";


/** Attendance_model: attendance records and salary advances. */
@Injectable()
export class AttendanceRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // ── Attendance ──────────────────────────────────────────────────────────────

  // getAttendanceListPaginated
  async attendancePage(orgUID: number, filter: Filter, limit: number, offset: number): Promise<{ rows: Row[]; total: number }> {
    const k = this.read;
    const base = () => {
      const qb = k("Transaction.AttendanceTbl as A").where({ "A.IsDeleted": 0, "A.OrgUID": orgUID });
      AttendanceRepository.attendanceFilter(qb, filter);
      return qb;
    };
    const [rows, count] = await Promise.all([
      base()
        .select(
          "A.AttendanceUID as TablePrimaryUID",
          "A.UserUID as EmployeeUID",
          k.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", ["A.AttendanceDate", "AttendanceDate"]),
          "A.Status",
          "A.CheckInTime",
          "A.CheckOutTime",
          "A.WorkingHours",
          "A.Remarks",
          k.raw("CONCAT(??, ' ', ??) AS ??", ["U.FirstName", "U.LastName", "EmployeeName"]),
          "U.EmployeeCode",
          "D.DepartmentName",
          "DS.DesignationName"
        )
        .join("Users.UserTbl as U", (on) => on.on("U.UserUID", "A.UserUID").andOnVal("U.IsDeleted", "=", 0))
        .leftJoin("Organisation.DepartmentTbl as D", (on) => on.on("D.DepartmentUID", "U.DepartmentUID").andOnVal("D.IsDeleted", "=", 0))
        .leftJoin("Organisation.DesignationTbl as DS", (on) => on.on("DS.DesignationUID", "U.DesignationUID").andOnVal("DS.IsDeleted", "=", 0))
        .orderBy("A.AttendanceDate", "desc")
        .orderBy("EmployeeName", "asc")
        .limit(limit)
        .offset(offset),
      base().count({ cnt: "*" }).first(),
    ]);
    return { rows: rows as Row[], total: Number(count?.cnt ?? 0) };
  }

  private static attendanceFilter(qb: Knex.QueryBuilder, filter: Filter): void {
    if (Number(filter.EmployeeUID) > 0) qb.where("A.UserUID", Number(filter.EmployeeUID));
    if (filter.Status) qb.where("A.Status", filter.Status);
    if (filter.DateFrom) qb.where("A.AttendanceDate", ">=", filter.DateFrom);
    if (filter.DateTo) qb.where("A.AttendanceDate", "<=", filter.DateTo);
    if (Number(filter.Month) > 0) qb.whereRaw("MONTH(??) = ?", ["A.AttendanceDate", Number(filter.Month)]);
    if (Number(filter.Year) > 0) qb.whereRaw("YEAR(??) = ?", ["A.AttendanceDate", Number(filter.Year)]);
  }

  // getMonthlyAttendance
  monthly(orgUID: number, year: number, month: number): Promise<Row[]> {
    const k = this.read;
    return k("Transaction.AttendanceTbl as A")
      .select(
        "A.AttendanceUID",
        "A.UserUID as EmployeeUID",
        k.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", ["A.AttendanceDate", "AttendanceDate"]),
        "A.Status",
        "A.CheckInTime",
        "A.CheckOutTime",
        "A.WorkingHours",
        "A.Remarks"
      )
      .where({ "A.OrgUID": orgUID, "A.IsDeleted": 0 })
      .whereBetween("A.AttendanceDate", AttendanceRepository.monthRange(year, month))
      .orderBy("A.UserUID", "asc")
      .orderBy("A.AttendanceDate", "asc");
  }

  // getDailyStats
  async dailyStats(orgUID: number, date: string): Promise<Row> {
    const row = await this.read("Transaction.AttendanceTbl as A")
      .select(
        this.read.raw(`SUM(CASE WHEN A.Status = 'Present' THEN 1 ELSE 0 END) AS PresentCount,
          SUM(CASE WHEN A.Status = 'Absent' THEN 1 ELSE 0 END) AS AbsentCount,
          SUM(CASE WHEN A.Status = 'Leave' THEN 1 ELSE 0 END) AS LeaveCount,
          SUM(CASE WHEN A.Status = 'HalfDay' THEN 1 ELSE 0 END) AS HalfDayCount,
          COUNT(DISTINCT A.UserUID) AS MarkedCount`)
      )
      .where({ "A.OrgUID": orgUID, "A.AttendanceDate": date, "A.IsDeleted": 0 })
      .first();
    return (row as Row | undefined) ?? {};
  }

  // getAttendanceSummaryForPayroll — present days (half day = 0.5), absent days and hours per employee
  summaryForPayroll(orgUID: number, year: number, month: number): Promise<Row[]> {
    return this.read("Transaction.AttendanceTbl as A")
      .select(
        "A.UserUID as EmployeeUID",
        this.read.raw(`SUM(CASE WHEN A.Status = 'Present' THEN 1.0 ELSE 0 END) + SUM(CASE WHEN A.Status = 'HalfDay' THEN 0.5 ELSE 0 END) AS PresentDays,
          SUM(CASE WHEN A.Status = 'Absent' THEN 1.0 ELSE 0 END) AS AbsentDays,
          SUM(CASE WHEN A.Status IN ('Present','HalfDay','Leave','Holiday') THEN IFNULL(A.WorkingHours, 0) ELSE 0 END) AS TotalHours`)
      )
      .where({ "A.OrgUID": orgUID, "A.IsDeleted": 0 })
      .whereBetween("A.AttendanceDate", AttendanceRepository.monthRange(year, month))
      .groupBy("A.UserUID");
  }

  // getHolidayDatesForMonth
  async holidayDates(orgUID: number, year: number, month: number): Promise<string[]> {
    const rows = await this.read("Organisation.HolidayTbl")
      .select(this.read.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", ["HolidayDate", "HolidayDate"]))
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .whereBetween("HolidayDate", AttendanceRepository.monthRange(year, month));
    return rows.map((r: Row) => String(r.HolidayDate));
  }

  /**
   * One record per employee and day (unique OrgUID + UserUID + AttendanceDate, deleted rows included): an existing
   * row for that day — even a deleted one — is overwritten and made live again. CI3 inserted and failed on it.
   */
  async upsertAttendance(row: Row): Promise<void> {
    const merge = Object.keys(row).filter((key) => !["OrgUID", "UserUID", "AttendanceDate", "CreatedBy"].includes(key));
    await this.db.write("Transaction.AttendanceTbl").insert({ ...row, IsDeleted: 0 }).onConflict(["OrgUID", "UserUID", "AttendanceDate"]).merge([...merge, "IsDeleted"]);
  }

  updateAttendance(orgUID: number, uid: number, data: Row): Promise<number> {
    return this.db.write("Transaction.AttendanceTbl").where({ AttendanceUID: uid, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  static monthRange(year: number, month: number): [string, string] {
    const mm = String(month).padStart(2, "0");
    return [`${year}-${mm}-01`, `${year}-${mm}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`];
  }

  // ── Salary advances ─────────────────────────────────────────────────────────

  // getAdvanceListPaginated (AdvanceUID filter too — CI3 approve / delete passed it but it was ignored)
  async advancePage(orgUID: number, filter: Filter, limit: number, offset: number): Promise<{ rows: Row[]; total: number }> {
    const k = this.read;
    const base = () => {
      const qb = k("Transaction.SalaryAdvanceTbl as SA")
        .join("Users.UserTbl as U", (on) => on.on("U.UserUID", "SA.UserUID").andOnVal("U.IsDeleted", "=", 0))
        .where({ "SA.OrgUID": orgUID, "SA.IsDeleted": 0 });
      if (Number(filter.AdvanceUID) > 0) qb.where("SA.AdvanceUID", Number(filter.AdvanceUID));
      if (Number(filter.EmployeeUID) > 0) qb.where("SA.UserUID", Number(filter.EmployeeUID));
      if (filter.AdvanceStatus) qb.where("SA.AdvanceStatus", filter.AdvanceStatus);
      if (filter.SearchAllData) {
        const like = AttendanceRepository.likePattern(filter.SearchAllData);
        qb.where((w) => w.whereRaw("CONCAT(??, ' ', ??) LIKE ?", ["U.FirstName", "U.LastName", like]).orWhere("SA.Reason", "like", like));
      }
      return qb;
    };
    const [rows, count] = await Promise.all([
      base()
        .select(
          "SA.AdvanceUID as TablePrimaryUID",
          "SA.UserUID as EmployeeUID",
          k.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", ["SA.AdvanceDate", "AdvanceDate"]),
          "SA.AdvanceAmount",
          "SA.AdvanceStatus",
          "SA.Reason as Remarks",
          "SA.BalancePending",
          "SA.IsSettled",
          k.raw("CONCAT(??, ' ', ??) AS ??", ["U.FirstName", "U.LastName", "EmployeeName"]),
          "U.EmployeeCode"
        )
        .orderBy("SA.AdvanceUID", "desc")
        .limit(limit)
        .offset(offset),
      base().count({ cnt: "*" }).first(),
    ]);
    return { rows: rows as Row[], total: Number(count?.cnt ?? 0) };
  }

  // getAdvanceStats
  async advanceStats(orgUID: number): Promise<Row> {
    const row = await this.read("Transaction.SalaryAdvanceTbl")
      .select(
        this.read.raw(`COUNT(*) AS TotalCount,
          IFNULL(SUM(AdvanceStatus = 'Requested'), 0) AS RequestedCount,
          IFNULL(SUM(AdvanceStatus = 'Approved'), 0) AS ApprovedCount,
          IFNULL(SUM(AdvanceStatus = 'Settled'), 0) AS SettledCount,
          IFNULL(SUM(AdvanceStatus = 'Rejected'), 0) AS RejectedCount,
          IFNULL(SUM(AdvanceAmount), 0) AS TotalAmount,
          IFNULL(SUM(CASE WHEN AdvanceStatus = 'Requested' THEN AdvanceAmount ELSE 0 END), 0) AS RequestedAmount,
          IFNULL(SUM(CASE WHEN AdvanceStatus = 'Approved' THEN BalancePending ELSE 0 END), 0) AS ApprovedAmount,
          IFNULL(SUM(CASE WHEN AdvanceStatus = 'Settled' THEN AdvanceAmount ELSE 0 END), 0) AS SettledAmount`)
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? {};
  }

  async findAdvance(orgUID: number, uid: number): Promise<Row | null> {
    const row = await this.read("Transaction.SalaryAdvanceTbl")
      .select("AdvanceUID", "UserUID", this.read.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", ["AdvanceDate", "AdvanceDate"]), "AdvanceAmount", "AdvanceStatus", "BalancePending")
      .where({ AdvanceUID: uid, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? null;
  }

  async insertAdvance(data: Row): Promise<number> {
    const [id] = await this.db.write("Transaction.SalaryAdvanceTbl").insert(data);
    return Number(id);
  }

  updateAdvance(orgUID: number, uid: number, data: Row, where: Row = {}, trx?: Knex.Transaction): Promise<number> {
    return (trx ?? this.db.write)("Transaction.SalaryAdvanceTbl").where({ AdvanceUID: uid, OrgUID: orgUID, IsDeleted: 0, ...where }).update(data);
  }

  /**
   * getPendingAdvanceBalance — what payroll may recover. Approved advances only: CI3 also recovered advances
   * still awaiting approval and rejected ones (both keep IsSettled 0 and a balance).
   */
  async pendingAdvanceBalances(orgUID: number, trx?: Knex.Transaction): Promise<Map<number, number>> {
    const rows = await (trx ?? this.read)("Transaction.SalaryAdvanceTbl")
      .select("UserUID", this.read.raw("IFNULL(SUM(BalancePending), 0) AS TotalPending"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsSettled: 0, AdvanceStatus: "Approved" })
      .groupBy("UserUID");
    return new Map(rows.map((r: Row) => [Number(r.UserUID), Number(r.TotalPending)]));
  }

  // Payroll_model::getUnsettledAdvances for the CI3 app — read only (no lock); approved advances only
  openAdvances(orgUID: number, userUID: number): Promise<Row[]> {
    return this.read("Transaction.SalaryAdvanceTbl")
      .select("AdvanceUID", "BalancePending")
      .where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0, IsSettled: 0, AdvanceStatus: "Approved" })
      .where("BalancePending", ">", 0)
      .orderBy("AdvanceUID", "asc");
  }

  // getUnsettledAdvances — oldest first, for recovery
  unsettledAdvances(trx: Knex.Transaction, orgUID: number, userUID: number): Promise<Row[]> {
    return trx("Transaction.SalaryAdvanceTbl")
      .select("AdvanceUID", "BalancePending")
      .where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0, IsSettled: 0, AdvanceStatus: "Approved" })
      .where("BalancePending", ">", 0)
      .orderBy("AdvanceUID", "asc")
      .forUpdate();
  }

  // Advances partly or fully recovered by payroll, newest first — to give a recovery back
  recoveredAdvances(trx: Knex.Transaction, orgUID: number, userUID: number): Promise<Row[]> {
    return trx("Transaction.SalaryAdvanceTbl")
      .select("AdvanceUID", "AdvanceAmount", "BalancePending")
      .where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 })
      .whereIn("AdvanceStatus", ["Approved", "Settled"])
      .whereRaw("?? < ??", ["BalancePending", "AdvanceAmount"])
      .orderBy("AdvanceUID", "desc")
      .forUpdate();
  }

}
