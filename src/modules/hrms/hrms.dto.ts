import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { Allow, IsInt, IsOptional, Min } from "class-validator";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { HrmsBranchWriteDto, HrmsWriteDto } from "./hrms-common";

// ── Departments / Designations / Holidays ───────────────────────────────────────

export class DepartmentFormDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number, description: "0 to create" }) @Allow() DepartmentUID?: string | number;
  @ApiPropertyOptional({ description: "Required, up to 100 characters" }) @Allow() DepartmentName?: string;
  @ApiPropertyOptional() @Allow() Description?: string;
  @ApiPropertyOptional({ type: Number, description: "Sent by the page for system rows; system rows cannot be changed" }) @Allow() IsSystem?: string | number;
}

export class DepartmentIdDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() DepartmentUID?: string | number;
}

export class DesignationFormDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number, description: "0 to create" }) @Allow() DesignationUID?: string | number;
  @ApiPropertyOptional({ description: "Required, up to 100 characters" }) @Allow() DesignationName?: string;
  @ApiPropertyOptional() @Allow() Description?: string;
}

export class DesignationIdDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() DesignationUID?: string | number;
}

export class HolidayFormDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number, description: "0 to create" }) @Allow() HolidayUID?: string | number;
  @ApiPropertyOptional({ description: "Required, up to 150 characters" }) @Allow() HolidayName?: string;
  @ApiPropertyOptional({ description: "Required, YYYY-MM-DD" }) @Allow() HolidayDate?: string;
  @ApiPropertyOptional() @Allow() Description?: string;
  @ApiPropertyOptional({ type: Number, description: "1 = optional holiday" }) @Allow() IsOptional?: string | number;
}

export class HolidayIdDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() HolidayUID?: string | number;
}

// ── Attendance ──────────────────────────────────────────────────────────────────

export class MonthQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number, description: "1-12; default the current month" }) @Allow() Month?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Default the current year" }) @Allow() Year?: string | number;
}

export class AttendanceFormDto extends HrmsBranchWriteDto {
  @ApiPropertyOptional({ type: Number, description: "0 to create (an existing record of the employee for that day is overwritten)" }) @Allow() AttendanceUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Required (UserUID)" }) @Allow() EmployeeUID?: string | number;
  @ApiPropertyOptional({ description: "Required, YYYY-MM-DD" }) @Allow() AttendanceDate?: string;
  @ApiPropertyOptional({ enum: ["Present", "Absent", "HalfDay", "Leave", "Holiday", "WeekOff"] }) @Allow() Status?: string;
  @ApiPropertyOptional({ description: "HH:MM" }) @Allow() CheckInTime?: string;
  @ApiPropertyOptional({ description: "HH:MM" }) @Allow() CheckOutTime?: string;
  @ApiPropertyOptional() @Allow() Remarks?: string;
}

export class AttendanceBulkDto extends HrmsBranchWriteDto {
  @ApiPropertyOptional({ description: "Records[]: { AttendanceUID, EmployeeUID, AttendanceDate, Status, CheckIn, CheckOut, Remarks } (array, Records[0][..] or JSON)" })
  @Allow()
  Records?: unknown;
}

export class AttendanceIdDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() AttendanceUID?: string | number;
}

// ── Salary advances ─────────────────────────────────────────────────────────────

export class AdvanceFormDto extends HrmsBranchWriteDto {
  @ApiPropertyOptional({ type: Number, description: "0 to request; an advance awaiting approval to change" }) @Allow() AdvanceUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Required (UserUID)" }) @Allow() EmployeeUID?: string | number;
  @ApiPropertyOptional({ description: "Required, YYYY-MM-DD" }) @Allow() AdvanceDate?: string;
  @ApiPropertyOptional({ type: Number, description: "Greater than 0" }) @Allow() AdvanceAmount?: string | number;
  @ApiPropertyOptional() @Allow() Remarks?: string;
  @ApiPropertyOptional({ description: "Used when Remarks is empty" }) @Allow() Reason?: string;
}

export class AdvanceIdDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() AdvanceUID?: string | number;
}

// ── Payroll ─────────────────────────────────────────────────────────────────────

export class PayrollEmployeesDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number, example: 1, description: "BranchUID the payroll is for" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId?: number;

  @ApiPropertyOptional({ type: Number, description: "Required, 1-12" }) @Allow() Month?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Required" }) @Allow() Year?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Sent by the page; working days are counted from the calendar (Sundays off)" }) @Allow() WorkingDays?: string | number;
}

export class PayrollSaveDto extends HrmsBranchWriteDto {
  @ApiPropertyOptional({ type: Number, description: "Required, 1-12" }) @Allow() Month?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Required" }) @Allow() Year?: string | number;
  @ApiPropertyOptional({ enum: ["Draft", "Processed"], description: "Default Processed" }) @Allow() Status?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: Number, description: "Sent by the page; the month's run is found by Month / Year" }) @Allow() PayrollUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() WorkingDays?: string | number;
  @ApiPropertyOptional({ description: "Lines[] as getPayrollEmployees returns them (array, Lines[0][..] or JSON); NetPayable, when sent, is the saved net" })
  @Allow()
  Lines?: unknown;
}

export class PayrollStatusDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() PayrollUID?: string | number;
  @ApiPropertyOptional({ enum: ["Draft", "Processed", "Paid", "Cancelled"] }) @Allow() Status?: string;
}

export class PayrollIdDto extends HrmsWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() PayrollUID?: string | number;
}
