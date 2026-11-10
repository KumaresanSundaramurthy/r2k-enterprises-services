import { Injectable } from "@nestjs/common";
import { phpRound } from "../../common/utils/php-compat";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postValue } from "../../core/utils/form-values";
import { JournalService } from "../../libraries/journal/journal.service";
import { AttendanceRepository } from "./attendance.repository";
import { arrayOf, Filter, filterOf, isDate, Page, Row, todayIn } from "./hrms-common";
import { HrmsMastersRepository } from "./hrms-masters.repository";

type Form = Record<string, unknown>;

const STATUSES = ["Present", "Absent", "HalfDay", "Leave", "Holiday", "WeekOff"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const AMOUNT_DECIMALS = 2;

const text = (form: Form, key: string) => String(postValue(form, key) ?? "").trim();
const time = (value: unknown) => (typeof value === "string" && TIME.test(value.trim()) ? value.trim() : null);
const seconds = (t: string) => t.split(":").reduce((acc, part, i) => acc + Number(part) * [3600, 60, 1][i], 0);

// Worked hours from check-in / check-out (CI3: only when check-out is later)
function workingHours(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null;
  const diff = seconds(checkOut) - seconds(checkIn);
  return diff > 0 ? phpRound(diff / 3600, 2) : null;
}

/** CI3 Attendance and Salaryadvances controllers. */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly repo: AttendanceRepository,
    private readonly masters: HrmsMastersRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly journal: JournalService
  ) {}

  // ── Attendance ──────────────────────────────────────────────────────────────

  // index — today's records (org timezone), today's stats and the employee list
  async attendancePageData(orgUID: number, rowLimit: number | undefined) {
    const today = todayIn((await this.orgSettings.get(orgUID)).Timezone);
    const [page, stats, employees] = await Promise.all([
      this.attendancePage(orgUID, 1, rowLimit, { DateFrom: today, DateTo: today }),
      this.repo.dailyStats(orgUID, today),
      this.masters.employees(orgUID),
    ]);
    return { ...page, DailyStats: stats, EmployeeList: employees, TodayDate: today };
  }

  async attendancePage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter): Promise<Page> {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const { rows, total } = await this.repo.attendancePage(orgUID, filter, limit, (page - 1) * limit);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit };
  }

  // monthly / getMonthlyData — the month's records, employees, holidays and the number of days
  async monthly(orgUID: number, month: number, year: number) {
    const today = todayIn((await this.orgSettings.get(orgUID)).Timezone);
    const m = month >= 1 && month <= 12 ? month : Number(today.slice(5, 7));
    const y = year >= 1900 && year <= 9999 ? year : Number(today.slice(0, 4));
    const [data, employees, holidays] = await Promise.all([this.repo.monthly(orgUID, y, m), this.masters.employees(orgUID), this.repo.holidayDates(orgUID, y, m)]);
    return { Data: data, AttendanceData: data, EmployeeList: employees, HolidayDates: holidays, Month: m, Year: y, DaysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate() };
  }

  // getDashboardStats — today's counts
  async dailyStats(orgUID: number) {
    const today = todayIn((await this.orgSettings.get(orgUID)).Timezone);
    return { Data: await this.repo.dailyStats(orgUID, today) };
  }

  // save — one record; the employee's existing record for that day is overwritten
  async saveAttendance(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "AttendanceUID");
    const employeeUID = postInt(form, "EmployeeUID");
    const date = text(form, "AttendanceDate");
    const status = text(form, "Status");
    if (!employeeUID) throw new CiValidationError("Employee is required.");
    if (!date) throw new CiValidationError("Date is required.");
    if (!isDate(date)) throw new CiValidationError("Date is not a valid date.");
    if (!status) throw new CiValidationError("Status is required.");
    if (!STATUSES.includes(status)) throw new CiValidationError("Invalid status.");
    // CI3 accepted any UserUID, including another org's staff
    if (!(await this.masters.orgEmployeeUIDs(ctx.orgUID, [employeeUID])).has(employeeUID)) throw new CiValidationError("Employee not found.");

    const checkIn = time(postValue(form, "CheckInTime"));
    const checkOut = time(postValue(form, "CheckOutTime"));
    const row: Row = {
      OrgUID: ctx.orgUID,
      BranchUID: ctx.branchUID ?? 1,
      UserUID: employeeUID,
      AttendanceDate: date,
      Status: status,
      CheckInTime: checkIn,
      CheckOutTime: checkOut,
      WorkingHours: workingHours(checkIn, checkOut),
      Remarks: text(form, "Remarks").slice(0, 255),
      UpdatedBy: ctx.userUID,
    };
    if (uid > 0) {
      try {
        if ((await this.repo.updateAttendance(ctx.orgUID, uid, row)) === 0) throw new CiValidationError("Attendance record not found.");
      } catch (err) {
        if ((err as { code?: string }).code === "ER_DUP_ENTRY") throw new CiValidationError("This employee already has attendance marked for that date.");
        throw err;
      }
    } else {
      await this.repo.upsertAttendance({ ...row, CreatedBy: ctx.userUID });
    }
    return { Message: "Attendance saved." };
  }

  /**
   * saveBulk — several employees / days at once (Records[]). Rows with a missing or unknown employee, date or status
   * are skipped; CI3 counted every row as saved even when the database refused it. CheckIn / CheckOut, which the
   * page sends, are stored too (CI3 dropped them).
   */
  async saveBulk(ctx: WriteContext, form: Form) {
    const records = arrayOf<Row>(form.Records);
    if (records.length === 0) throw new CiValidationError("No records provided.");
    const staff = await this.masters.orgEmployeeUIDs(ctx.orgUID, records.map((r) => parseInt(String(r.EmployeeUID ?? ""), 10)).filter((n) => n > 0));

    let saved = 0;
    for (const record of records) {
      const employeeUID = parseInt(String(record.EmployeeUID ?? ""), 10);
      const date = String(record.AttendanceDate ?? "").trim();
      const status = String(record.Status ?? "").trim();
      if (!staff.has(employeeUID) || !isDate(date) || !STATUSES.includes(status)) continue;

      const checkIn = time(record.CheckIn ?? record.CheckInTime);
      const checkOut = time(record.CheckOut ?? record.CheckOutTime);
      const row: Row = {
        OrgUID: ctx.orgUID,
        BranchUID: ctx.branchUID ?? 1,
        UserUID: employeeUID,
        AttendanceDate: date,
        Status: status,
        CheckInTime: checkIn,
        CheckOutTime: checkOut,
        WorkingHours: workingHours(checkIn, checkOut),
        Remarks: String(record.Remarks ?? "").trim().slice(0, 255),
        UpdatedBy: ctx.userUID,
      };
      const uid = parseInt(String(record.AttendanceUID ?? ""), 10) || 0;
      try {
        if (uid > 0) {
          if ((await this.repo.updateAttendance(ctx.orgUID, uid, row)) > 0) saved++;
        } else {
          await this.repo.upsertAttendance({ ...row, CreatedBy: ctx.userUID });
          saved++;
        }
      } catch (err) {
        if ((err as { code?: string }).code !== "ER_DUP_ENTRY") throw err;
      }
    }
    return { Message: `${saved} record(s) saved.`, SavedCount: saved };
  }

  async deleteAttendance(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "AttendanceUID");
    if (!uid) throw new CiValidationError("Invalid.");
    if ((await this.repo.updateAttendance(ctx.orgUID, uid, { IsDeleted: 1, UpdatedBy: ctx.userUID })) === 0) throw new CiValidationError("Attendance record not found.");
    return { Message: "Deleted." };
  }

  // ── Salary advances ─────────────────────────────────────────────────────────

  async advancePageData(orgUID: number, rowLimit: number | undefined) {
    const [page, employees] = await Promise.all([this.advancePage(orgUID, 1, rowLimit, {}), this.masters.employees(orgUID)]);
    return { ...page, AdvanceStats: page.Stats, EmployeeList: employees };
  }

  async advancePage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter): Promise<Page & { Stats: Row }> {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const [{ rows, total }, stats] = await Promise.all([this.repo.advancePage(orgUID, filter, limit, (page - 1) * limit), this.repo.advanceStats(orgUID)]);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit, Stats: stats };
  }

  // save — request a new advance, or change one still awaiting approval
  async saveAdvance(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "AdvanceUID");
    const employeeUID = postInt(form, "EmployeeUID");
    const date = text(form, "AdvanceDate");
    const amount = phpRound(Number(postValue(form, "AdvanceAmount") ?? 0) || 0, AMOUNT_DECIMALS);
    if (!employeeUID) throw new CiValidationError("Employee is required.");
    if (!date) throw new CiValidationError("Date is required.");
    if (!isDate(date)) throw new CiValidationError("Date is not a valid date.");
    if (amount <= 0) throw new CiValidationError("Amount must be greater than 0.");
    if (!(await this.masters.orgEmployeeUIDs(ctx.orgUID, [employeeUID])).has(employeeUID)) throw new CiValidationError("Employee not found.");

    const data: Row = {
      OrgUID: ctx.orgUID,
      BranchUID: ctx.branchUID ?? 1,
      UserUID: employeeUID,
      AdvanceDate: date,
      AdvanceAmount: amount,
      Reason: (text(form, "Remarks") || text(form, "Reason")).slice(0, 255),
      UpdatedBy: ctx.userUID,
    };
    if (uid === 0) {
      await this.repo.insertAdvance({ ...data, BalancePending: amount, IsSettled: 0, AdvanceStatus: "Requested", CreatedBy: ctx.userUID });
    } else {
      // The balance follows the amount while nothing has been approved or recovered (CI3 left the old balance)
      const changed = await this.repo.updateAdvance(ctx.orgUID, uid, { ...data, BalancePending: amount }, { AdvanceStatus: "Requested" });
      if (changed === 0) throw new CiValidationError("Only advances awaiting approval can be edited.");
    }
    return { Message: uid ? "Advance request updated." : "Advance request submitted.", ...(await this.advanceRefreshed(ctx.orgUID, form)) };
  }

  // approve — and its journal (Dr Employee Advances, Cr Accounts Payable)
  async approveAdvance(ctx: WriteContext, form: Form) {
    const advance = await this.requestedAdvance(ctx, form);
    const uid = Number(advance.AdvanceUID);
    if ((await this.repo.updateAdvance(ctx.orgUID, uid, { AdvanceStatus: "Approved", UpdatedBy: ctx.userUID }, { AdvanceStatus: "Requested" })) === 0) {
      throw new CiValidationError("Only advances awaiting approval can be approved.");
    }
    const date = String(advance.AdvanceDate);
    await this.journal.postAfterSave(`Salary advance ${uid}`, (trx) => this.journal.postSalaryAdvance(trx, ctx.orgUID, uid, date, Number(advance.AdvanceAmount), ctx.userUID));
    return { Message: "Advance approved.", ...(await this.advanceRefreshed(ctx.orgUID, form)) };
  }

  async rejectAdvance(ctx: WriteContext, form: Form) {
    const advance = await this.requestedAdvance(ctx, form);
    if ((await this.repo.updateAdvance(ctx.orgUID, Number(advance.AdvanceUID), { AdvanceStatus: "Rejected", UpdatedBy: ctx.userUID }, { AdvanceStatus: "Requested" })) === 0) {
      throw new CiValidationError("Only advances awaiting approval can be rejected.");
    }
    return { Message: "Advance rejected.", ...(await this.advanceRefreshed(ctx.orgUID, form)) };
  }

  // delete — an approved advance's journal is reversed
  async deleteAdvance(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "AdvanceUID");
    if (!uid) throw new CiValidationError("Invalid.");
    // CI3 looked the advance up with a filter its query ignored, so it checked the newest advance instead
    const advance = await this.repo.findAdvance(ctx.orgUID, uid);
    if (!advance) throw new CiValidationError("Advance not found.");
    await this.repo.updateAdvance(ctx.orgUID, uid, { IsDeleted: 1, UpdatedBy: ctx.userUID });
    if (advance.AdvanceStatus === "Approved" || advance.AdvanceStatus === "Settled") {
      await this.journal.postAfterSave(`Salary advance ${uid} reversal`, (trx) => this.journal.reverse(trx, ctx.orgUID, "SalaryAdvance", uid, ctx.userUID));
    }
    return { Message: "Advance deleted.", ...(await this.advanceRefreshed(ctx.orgUID, form)) };
  }

  private async requestedAdvance(ctx: WriteContext, form: Form): Promise<Row> {
    const uid = postInt(form, "AdvanceUID");
    if (!uid) throw new CiValidationError("Invalid advance.");
    const advance = await this.repo.findAdvance(ctx.orgUID, uid);
    if (!advance) throw new CiValidationError("Advance not found.");
    return advance;
  }

  // CI3 answered every advance write with page 1 of the posted filter
  private advanceRefreshed(orgUID: number, form: Form) {
    return this.advancePage(orgUID, postInt(form, "CurrentPage") || 1, postInt(form, "RowLimit") || undefined, filterOf(form.Filter));
  }
}
