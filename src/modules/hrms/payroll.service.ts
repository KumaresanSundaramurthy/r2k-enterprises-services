import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { phpRound } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { JournalService } from "../../libraries/journal/journal.service";
import { AttendanceRepository } from "./attendance.repository";
import { arrayOf, Filter, nowIn, Page, Row, todayIn } from "./hrms-common";
import { HrmsMastersRepository } from "./hrms-masters.repository";
import { PayrollRepository } from "./payroll.repository";

type Form = Record<string, unknown>;

const DEC = 2; // CI3 MY_Controller::_decimals
const STATUSES = ["Draft", "Processed", "Paid", "Cancelled"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const num = (value: unknown) => Number(value ?? 0) || 0;

// getWorkingDaysInMonth — calendar days of the month except Sundays
function workingDaysInMonth(year: number, month: number): number {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let working = 0;
  for (let d = 1; d <= days; d++) if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() !== 0) working++;
  return working;
}

function monthYear(form: Form): { month: number; year: number } {
  const month = postInt(form, "Month");
  const year = postInt(form, "Year");
  if (!month || !year) throw new CiValidationError("Month and Year are required.");
  if (month < 1 || month > 12 || year < 1900 || year > 9999) throw new CiValidationError("Invalid month or year.");
  return { month, year };
}

/** CI3 Payroll and Payslips controllers. */
@Injectable()
export class PayrollService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: PayrollRepository,
    private readonly attendance: AttendanceRepository,
    private readonly masters: HrmsMastersRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly journal: JournalService,
    private readonly audit: AuditLogService
  ) {}

  // ── Payroll list ────────────────────────────────────────────────────────────

  async payrollPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter): Promise<Page> {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const { rows, total } = await this.repo.payrollPage(orgUID, filter, limit, (page - 1) * limit);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit };
  }

  async payrollPageData(orgUID: number, rowLimit: number | undefined) {
    const [page, stats] = await Promise.all([this.payrollPage(orgUID, 1, rowLimit, {}), this.repo.payrollStats(orgUID)]);
    return { ...page, PayrollStats: stats };
  }

  // process — what the process page opens with
  async processPageData(orgUID: number) {
    const today = todayIn((await this.orgSettings.get(orgUID)).Timezone);
    const employees = await this.masters.employees(orgUID);
    return { EmployeeCount: employees.length, CurrentMonth: Number(today.slice(5, 7)), CurrentYear: Number(today.slice(0, 4)) };
  }

  // viewPayroll — the run and its lines
  async payrollDetail(orgUID: number, payrollUID: number) {
    const payroll = await this.repo.payroll(orgUID, payrollUID);
    if (!payroll) throw new CiValidationError("Payroll not found.");
    return { Payroll: payroll, PayrollLines: await this.repo.payrollLines(orgUID, payrollUID) };
  }

  /**
   * getPayrollEmployees — each employee's salary for the month from attendance (Monthly: gross less absent days at
   * gross / working days; Daily: basic x present days; Hourly: basic x hours), less fixed deductions, less what is
   * pending on approved advances. Reprocessing a month counts the advance the earlier run recovered as pending again.
   */
  async payrollEmployees(orgUID: number, branchUID: number, form: Form) {
    const { month, year } = monthYear(form);
    const existing = await this.repo.payrollOfMonth(orgUID, branchUID, month, year);
    const live = existing && num(existing.IsDeleted) === 0 ? existing : null;

    const [employees, summary, pending, previousLines] = await Promise.all([
      this.masters.employees(orgUID),
      this.attendance.summaryForPayroll(orgUID, year, month),
      this.attendance.pendingAdvanceBalances(orgUID),
      live ? this.repo.payrollLines(orgUID, Number(live.PayrollUID)) : Promise.resolve([] as Row[]),
    ]);
    const workDays = workingDaysInMonth(year, month);
    const att = new Map(summary.map((a) => [Number(a.EmployeeUID), a]));
    for (const line of previousLines) {
      const uid = Number(line.EmployeeUID);
      pending.set(uid, (pending.get(uid) ?? 0) + num(line.AdvanceRecovery));
    }

    const lines = employees.map((emp) => {
      const uid = Number(emp.EmployeeUID);
      const a = att.get(uid);
      const present = num(a?.PresentDays);
      const absent = num(a?.AbsentDays);
      const hours = num(a?.TotalHours);
      const basic = num(emp.BasicSalary);
      const allowances = num(emp.Allowances);
      const incentives = num(emp.Incentives);
      const fixed = num(emp.FixedDeductions);
      let gross = basic + allowances + incentives;
      let deduction = 0;
      let net: number;
      if (emp.SalaryType === "Monthly") {
        const perDay = workDays > 0 ? gross / workDays : 0;
        deduction = phpRound(absent * perDay, DEC);
        net = phpRound(gross - deduction - fixed, DEC);
      } else if (emp.SalaryType === "Daily") {
        gross = phpRound(basic * present, DEC);
        net = phpRound(gross - fixed, DEC);
      } else {
        gross = phpRound(basic * hours, DEC);
        net = phpRound(gross - fixed, DEC);
      }
      if (net < 0) net = 0;
      const advanceRecovery = phpRound(Math.min(pending.get(uid) ?? 0, net), DEC);
      net = Math.max(0, phpRound(net - advanceRecovery, DEC));

      return {
        EmployeeUID: uid,
        EmployeeName: emp.EmployeeName,
        EmployeeCode: emp.EmployeeCode,
        SalaryType: emp.SalaryType,
        BasicSalary: basic,
        Allowances: allowances,
        Incentives: incentives,
        GrossSalary: gross,
        WorkingDays: workDays,
        PresentDays: present,
        AbsentDays: absent,
        HoursWorked: hours,
        SalaryDeduction: deduction,
        FixedDeductions: fixed,
        AdvanceRecovery: advanceRecovery,
        NetSalary: net,
        // The process page's names: deductions other than the advance, all deductions, take-home and its adjustment
        OtherDeductions: phpRound(deduction + fixed, DEC),
        TotalDeductions: phpRound(deduction + fixed + advanceRecovery, DEC),
        NetPayable: net,
        Adjustment: 0,
      };
    });

    // Lines as CI3 answered; Employees is what the process page reads
    return { Lines: lines, Employees: lines, WorkDays: workDays, Existing: live ? Number(live.PayrollUID) : 0, ExistStatus: live ? String(live.PayrollStatus) : "" };
  }

  /**
   * savePayroll — saves the month's run (Status Draft or Processed, default Processed) with one line per employee and
   * recovers the advances. Reprocessing gives back what the earlier run recovered first, so advances are not
   * recovered twice (CI3 recovered them again on every reprocess). The journal is posted for a processed run.
   */
  async savePayroll(ctx: WriteContext, form: Form) {
    const { month, year } = monthYear(form);
    const branchUID = ctx.branchUID ?? 1;
    const status = postValue(form, "Status") === "Draft" ? "Draft" : "Processed";
    const notes = String(postValue(form, "Notes") ?? "").trim();
    const lines = arrayOf<Row>(form.Lines)
      .map((l): Row & { EmployeeUID: number } => ({ ...l, EmployeeUID: parseInt(String(l.EmployeeUID ?? ""), 10) }))
      .filter((l) => l.EmployeeUID > 0);
    if (lines.length === 0) throw new CiValidationError("No payroll lines provided.");
    const staff = await this.masters.orgEmployeeUIDs(ctx.orgUID, lines.map((l) => l.EmployeeUID));
    if (lines.some((l) => !staff.has(l.EmployeeUID))) throw new CiValidationError("A payroll line is for an employee who is not in this organisation.");
    if (new Set(lines.map((l) => l.EmployeeUID)).size !== lines.length) throw new CiValidationError("An employee appears more than once in the payroll lines.");

    // The take-home the page shows (with its adjustment) is what is saved
    const net = (l: Row) => phpRound(num(l.NetPayable ?? l.NetSalary), DEC);
    let totalGross = 0;
    let totalDeductions = 0;
    let totalNet = 0;
    let totalAdvance = 0;
    for (const l of lines) {
      totalGross += num(l.GrossSalary);
      totalDeductions += num(l.SalaryDeduction) + num(l.FixedDeductions) + num(l.AdvanceRecovery);
      totalNet += net(l);
      totalAdvance += num(l.AdvanceRecovery);
    }
    [totalGross, totalDeductions, totalNet, totalAdvance] = [totalGross, totalDeductions, totalNet, totalAdvance].map((v) => phpRound(v, DEC));

    const tz = (await this.orgSettings.get(ctx.orgUID)).Timezone;
    const header: Row = {
      TotalEmployees: lines.length,
      TotalGrossSalary: totalGross,
      TotalDeductions: totalDeductions,
      TotalNetSalary: totalNet,
      PayrollStatus: status,
      ProcessedOn: status === "Processed" ? nowIn(tz) : null,
      Notes: notes,
      UpdatedBy: ctx.userUID,
    };

    const payrollUID = await this.db.write.transaction(async (trx) => {
      const existing = await this.repo.payrollOfMonth(ctx.orgUID, branchUID, month, year, trx);
      let uid: number;
      if (existing) {
        uid = Number(existing.PayrollUID);
        if (num(existing.IsDeleted) === 0) {
          if (existing.PayrollStatus === "Paid") throw new CiValidationError("This payroll is already marked as Paid and cannot be reprocessed.");
          await this.giveBackRecoveries(trx, ctx, await this.repo.payrollLines(ctx.orgUID, uid, trx));
          await this.repo.deleteLines(trx, ctx.orgUID, uid, ctx.userUID);
        }
        await this.repo.updatePayroll(ctx.orgUID, uid, { ...header, IsDeleted: 0 }, trx);
      } else {
        uid = await this.repo.insertPayroll(trx, { ...header, OrgUID: ctx.orgUID, BranchUID: branchUID, PayrollMonth: month, PayrollYear: year, CreatedBy: ctx.userUID });
      }

      for (const l of lines) {
        await this.repo.upsertLine(trx, {
          PayrollUID: uid,
          OrgUID: ctx.orgUID,
          UserUID: l.EmployeeUID,
          SalaryType: ["Monthly", "Daily", "Hourly"].includes(String(l.SalaryType)) ? l.SalaryType : "Monthly",
          BasicSalary: num(l.BasicSalary),
          Allowances: num(l.Allowances),
          Incentives: num(l.Incentives),
          GrossSalary: num(l.GrossSalary),
          WorkingDays: Math.trunc(num(l.WorkingDays)),
          PresentDays: num(l.PresentDays),
          AbsentDays: num(l.AbsentDays),
          HoursWorked: num(l.HoursWorked),
          SalaryDeduction: num(l.SalaryDeduction),
          FixedDeductions: num(l.FixedDeductions),
          AdvanceRecovery: num(l.AdvanceRecovery),
          NetSalary: net(l),
          CreatedBy: ctx.userUID,
          UpdatedBy: ctx.userUID,
        });
        if (num(l.AdvanceRecovery) > 0) await this.recover(trx, ctx, l.EmployeeUID, num(l.AdvanceRecovery));
      }
      return uid;
    });

    // Journal — the earlier run's is reversed; a processed run is posted on the last day of the month
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const date = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;
    await this.journal.postAfterSave(`Payroll ${payrollUID}`, async (trx) => {
      await this.journal.reverse(trx, ctx.orgUID, "Payroll", payrollUID, ctx.userUID);
      if (status === "Processed") {
        await this.journal.postPayroll(trx, {
          orgUID: ctx.orgUID,
          payrollUID,
          date,
          monthName: `${MONTHS[month - 1]} ${year}`,
          gross: totalGross,
          net: totalNet,
          deductions: totalDeductions,
          advanceRecovery: totalAdvance,
          userUID: ctx.userUID,
        });
      }
    });

    await this.audit.log(ctx, {
      action: "SAVE_PAYROLL",
      entityType: "Payroll",
      entityUID: payrollUID,
      details: { Month: month, Year: year },
      summary: `Processed payroll for ${month}/${year}`,
      module: "Payroll",
      category: "TRANSACTION",
    });
    return { PayrollUID: payrollUID, Message: status === "Draft" ? "Draft saved." : "Payroll processed successfully." };
  }

  // updateStatus — a cancelled run's journal is reversed
  async updateStatus(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "PayrollUID");
    const status = String(postValue(form, "Status") ?? "");
    if (!uid || !STATUSES.includes(status)) throw new CiValidationError("Invalid request.");
    return this.setStatus(ctx, uid, status);
  }

  // markPaid — what the CI3 payroll page calls (CI3 had no such method, so the button failed)
  async markPaid(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "PayrollUID");
    if (!uid) throw new CiValidationError("Invalid request.");
    const payroll = await this.repo.payroll(ctx.orgUID, uid);
    if (!payroll) throw new CiValidationError("Payroll not found.");
    if (payroll.PayrollStatus !== "Processed") throw new CiValidationError("Only a processed payroll can be marked as Paid.");
    return this.setStatus(ctx, uid, "Paid");
  }

  private async setStatus(ctx: WriteContext, uid: number, status: string) {
    // CI3 reported success for another org's payroll
    if (!(await this.repo.payroll(ctx.orgUID, uid))) throw new CiValidationError("Payroll not found.");
    await this.repo.updatePayroll(ctx.orgUID, uid, { PayrollStatus: status, UpdatedBy: ctx.userUID });
    if (status === "Cancelled") {
      await this.journal.postAfterSave(`Payroll ${uid} reversal`, (trx) => this.journal.reverse(trx, ctx.orgUID, "Payroll", uid, ctx.userUID));
    }
    await this.audit.log(ctx, {
      action: "UPDATE_PAYROLL_STATUS",
      entityType: "Payroll",
      entityUID: uid,
      details: { NewStatus: status },
      summary: `Updated payroll status #${uid}`,
      module: "Payroll",
      category: "TRANSACTION",
    });
    return { Message: `Status updated to ${status}.` };
  }

  // delete — not a paid run; its lines, the advance it recovered (given back; CI3 kept it recovered) and its journal
  async deletePayroll(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "PayrollUID");
    if (!uid) throw new CiValidationError("Invalid.");
    const payroll = await this.repo.payroll(ctx.orgUID, uid);
    if (!payroll) throw new CiValidationError("Payroll not found.");
    if (payroll.PayrollStatus === "Paid") throw new CiValidationError("Paid payroll cannot be deleted.");

    await this.db.write.transaction(async (trx) => {
      await this.giveBackRecoveries(trx, ctx, await this.repo.payrollLines(ctx.orgUID, uid, trx));
      await this.repo.deleteLines(trx, ctx.orgUID, uid, ctx.userUID);
      await this.repo.updatePayroll(ctx.orgUID, uid, { IsDeleted: 1, UpdatedBy: ctx.userUID }, trx);
    });
    await this.journal.postAfterSave(`Payroll ${uid} reversal`, (trx) => this.journal.reverse(trx, ctx.orgUID, "Payroll", uid, ctx.userUID));
    await this.audit.log(ctx, { action: "DELETE_PAYROLL", entityType: "Payroll", entityUID: uid, summary: `Deleted payroll #${uid}`, module: "Payroll", category: "TRANSACTION" });
    return { Message: "Deleted." };
  }

  // _applyAdvanceRecovery — oldest approved advance first; a fully recovered advance becomes Settled
  private async recover(trx: Knex.Transaction, ctx: WriteContext, employeeUID: number, amount: number): Promise<void> {
    let remaining = amount;
    for (const adv of await this.attendance.unsettledAdvances(trx, ctx.orgUID, employeeUID)) {
      if (remaining <= 0) break;
      const deduct = Math.min(remaining, num(adv.BalancePending));
      const balance = Math.max(0, phpRound(num(adv.BalancePending) - deduct, DEC));
      const settled = balance <= 0;
      await this.attendance.updateAdvance(
        ctx.orgUID,
        Number(adv.AdvanceUID),
        { BalancePending: balance, IsSettled: settled ? 1 : 0, ...(settled ? { AdvanceStatus: "Settled" } : {}), UpdatedBy: ctx.userUID },
        {},
        trx
      );
      remaining = phpRound(remaining - deduct, DEC);
    }
  }

  // The reverse of recover(): newest recovered advance first, back up to its full amount
  private async giveBackRecoveries(trx: Knex.Transaction, ctx: WriteContext, lines: Row[]): Promise<void> {
    for (const line of lines) {
      let remaining = num(line.AdvanceRecovery);
      if (remaining <= 0) continue;
      for (const adv of await this.attendance.recoveredAdvances(trx, ctx.orgUID, Number(line.EmployeeUID))) {
        if (remaining <= 0) break;
        const give = Math.min(remaining, num(adv.AdvanceAmount) - num(adv.BalancePending));
        if (give <= 0) continue;
        await this.attendance.updateAdvance(
          ctx.orgUID,
          Number(adv.AdvanceUID),
          { BalancePending: phpRound(num(adv.BalancePending) + give, DEC), IsSettled: 0, AdvanceStatus: "Approved", UpdatedBy: ctx.userUID },
          {},
          trx
        );
        remaining = phpRound(remaining - give, DEC);
      }
    }
  }

  // ── Payslips ────────────────────────────────────────────────────────────────

  async payslipPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter): Promise<Page> {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const { rows, total } = await this.repo.payslipPage(orgUID, filter, limit, (page - 1) * limit);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit };
  }

  async payslipPageData(orgUID: number, rowLimit: number | undefined) {
    const [page, employees] = await Promise.all([this.payslipPage(orgUID, 1, rowLimit, {}), this.masters.employees(orgUID)]);
    return { ...page, EmployeeList: employees };
  }

  // viewPayslip / printPayslip — the payslip and the org header it is printed with
  async payslip(orgUID: number, payrollLineUID: number) {
    const slip = await this.repo.payslip(orgUID, payrollLineUID);
    if (!slip) throw new CiValidationError("Payslip not found.");
    return { Slip: slip, OrgInfo: (await this.orgSettings.getHeader(orgUID)) ?? {} };
  }
}
