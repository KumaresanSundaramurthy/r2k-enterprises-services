import { Module } from "@nestjs/common";
import { AttendanceRepository } from "./attendance.repository";
import { AttendanceService } from "./attendance.service";
import {
  AttendanceController,
  DepartmentsController,
  DesignationsController,
  HolidaysController,
  PayrollController,
  PayslipsController,
  SalaryAdvancesController,
} from "./hrms.controller";
import { HrmsMastersRepository } from "./hrms-masters.repository";
import { HrmsMastersService } from "./hrms-masters.service";
import { PayrollRepository } from "./payroll.repository";
import { PayrollService } from "./payroll.service";

// CI3 HRMS: Departments, Designations, Holidays, Attendance, Salaryadvances, Payroll and Payslips
@Module({
  controllers: [DepartmentsController, DesignationsController, HolidaysController, AttendanceController, SalaryAdvancesController, PayrollController, PayslipsController],
  providers: [HrmsMastersRepository, HrmsMastersService, AttendanceRepository, AttendanceService, PayrollRepository, PayrollService],
})
export class HrmsModule {}
