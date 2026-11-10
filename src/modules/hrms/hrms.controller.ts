import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { AcceptForm } from "../products/product-files";
import { AttendanceService } from "./attendance.service";
import { filterOf, HrmsListDto, pageOf, rowLimitOf } from "./hrms-common";
import {
  AdvanceFormDto,
  AdvanceIdDto,
  AttendanceBulkDto,
  AttendanceFormDto,
  AttendanceIdDto,
  DepartmentFormDto,
  DepartmentIdDto,
  DesignationFormDto,
  DesignationIdDto,
  HolidayFormDto,
  HolidayIdDto,
  MonthQueryDto,
  PayrollEmployeesDto,
  PayrollIdDto,
  PayrollSaveDto,
  PayrollStatusDto,
} from "./hrms.dto";
import { HrmsMastersService } from "./hrms-masters.service";
import { PayrollService } from "./payroll.service";

const PAGE_PARAM = { name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" };
const LIST = "Data, TotalCount, PageNo, RowLimit";

/** CI3 Departments controller. */
@ApiTags("HRMS - Departments")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/departments")
export class DepartmentsController {
  constructor(private readonly masters: HrmsMastersService) {}

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam(PAGE_PARAM)
  @ApiOperation({ summary: `One list page — the org's and the system departments; Filter JSON { SearchAllData } (${LIST})` })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: HrmsListDto) {
    return ciSuccess(await this.masters.masterPage("department", dto.orgId, pageOf(pageNo, dto), rowLimitOf(dto), filterOf(dto.Filter)));
  }

  @Get("getList")
  @ApiOperation({ summary: "Active departments for dropdowns (Data: [{ DepartmentUID, DepartmentName }])" })
  async getList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.masters.masterList("department", dto.orgId));
  }

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create (DepartmentUID 0) or update a department (Message and the refreshed page)" })
  async save(@Body() dto: DepartmentFormDto, @Req() req: Request) {
    return ciSuccess(await this.masters.masterSave("department", writeContext(dto, req), { ...dto }));
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete one of the org's departments (Message and the refreshed page)" })
  async delete(@Body() dto: DepartmentIdDto, @Req() req: Request) {
    return ciSuccess(await this.masters.masterDelete("department", writeContext(dto, req), { ...dto }));
  }
}

/** CI3 Designations controller. */
@ApiTags("HRMS - Designations")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/designations")
export class DesignationsController {
  constructor(private readonly masters: HrmsMastersService) {}

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam(PAGE_PARAM)
  @ApiOperation({ summary: `One list page — the org's and the system designations; Filter JSON { SearchAllData } (${LIST})` })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: HrmsListDto) {
    return ciSuccess(await this.masters.masterPage("designation", dto.orgId, pageOf(pageNo, dto), rowLimitOf(dto), filterOf(dto.Filter)));
  }

  @Get("getList")
  @ApiOperation({ summary: "Active designations for dropdowns (Data: [{ DesignationUID, DesignationName }])" })
  async getList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.masters.masterList("designation", dto.orgId));
  }

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create (DesignationUID 0) or update a designation (Message and the refreshed page)" })
  async save(@Body() dto: DesignationFormDto, @Req() req: Request) {
    return ciSuccess(await this.masters.masterSave("designation", writeContext(dto, req), { ...dto }));
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete one of the org's designations (Message and the refreshed page)" })
  async delete(@Body() dto: DesignationIdDto, @Req() req: Request) {
    return ciSuccess(await this.masters.masterDelete("designation", writeContext(dto, req), { ...dto }));
  }
}

/** CI3 Holidays controller. */
@ApiTags("HRMS - Holidays")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/holidays")
export class HolidaysController {
  constructor(private readonly masters: HrmsMastersService) {}

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam(PAGE_PARAM)
  @ApiOperation({ summary: `One list page; Filter JSON { Year (default this year), Month, SearchAllData } (${LIST}, CurrentYear)` })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: HrmsListDto) {
    return ciSuccess(await this.masters.holidayPage(dto.orgId, pageOf(pageNo, dto), rowLimitOf(dto), filterOf(dto.Filter)));
  }

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create (HolidayUID 0) or update a holiday (Message and the refreshed page)" })
  async save(@Body() dto: HolidayFormDto, @Req() req: Request) {
    return ciSuccess(await this.masters.holidaySave(writeContext(dto, req), { ...dto }));
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete a holiday (Message and the refreshed page)" })
  async delete(@Body() dto: HolidayIdDto, @Req() req: Request) {
    return ciSuccess(await this.masters.holidayDelete(writeContext(dto, req), { ...dto }));
  }
}

/** CI3 Attendance controller. */
@ApiTags("HRMS - Attendance")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/attendance")
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get("getPageData")
  @ApiOperation({ summary: `Page data: today's records (${LIST}), DailyStats, EmployeeList, TodayDate` })
  async getPageData(@Query() dto: HrmsListDto) {
    return ciSuccess(await this.attendance.attendancePageData(dto.orgId, rowLimitOf(dto)));
  }

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam(PAGE_PARAM)
  @ApiOperation({ summary: `One list page; Filter JSON { EmployeeUID, Status, DateFrom, DateTo, Month, Year } (${LIST})` })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: HrmsListDto) {
    return ciSuccess(await this.attendance.attendancePage(dto.orgId, pageOf(pageNo, dto), rowLimitOf(dto), filterOf(dto.Filter)));
  }

  @Get("getMonthlyData")
  @ApiOperation({ summary: "Monthly grid: Data (= AttendanceData), EmployeeList, HolidayDates, Month, Year, DaysInMonth" })
  async getMonthlyData(@Query() dto: MonthQueryDto) {
    return ciSuccess(await this.attendance.monthly(dto.orgId, Number(dto.Month) || 0, Number(dto.Year) || 0));
  }

  @Get("getDashboardStats")
  @ApiOperation({ summary: "Today's counts (Data: PresentCount, AbsentCount, LeaveCount, HalfDayCount, MarkedCount)" })
  async getDashboardStats(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.attendance.dailyStats(dto.orgId));
  }

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save one record; the employee's existing record for that day is overwritten" })
  async save(@Body() dto: AttendanceFormDto, @Req() req: Request) {
    return ciSuccess(await this.attendance.saveAttendance(writeContext(dto, req), { ...dto }));
  }

  @Post("saveBulk")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save several records (Records[]); invalid rows are skipped (Message, SavedCount)" })
  async saveBulk(@Body() dto: AttendanceBulkDto, @Req() req: Request) {
    return ciSuccess(await this.attendance.saveBulk(writeContext(dto, req), { ...dto }));
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete a record" })
  async delete(@Body() dto: AttendanceIdDto, @Req() req: Request) {
    return ciSuccess(await this.attendance.deleteAttendance(writeContext(dto, req), { ...dto }));
  }
}

/** CI3 Salaryadvances controller. */
@ApiTags("HRMS - Salary Advances")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/salaryadvances")
export class SalaryAdvancesController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get("getPageData")
  @ApiOperation({ summary: `Page data: page 1 (${LIST}), Stats (= AdvanceStats), EmployeeList` })
  async getPageData(@Query() dto: HrmsListDto) {
    return ciSuccess(await this.attendance.advancePageData(dto.orgId, rowLimitOf(dto)));
  }

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam(PAGE_PARAM)
  @ApiOperation({ summary: `One list page; Filter JSON { EmployeeUID, AdvanceStatus, SearchAllData } (${LIST}, Stats)` })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: HrmsListDto) {
    return ciSuccess(await this.attendance.advancePage(dto.orgId, pageOf(pageNo, dto), rowLimitOf(dto), filterOf(dto.Filter)));
  }

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Request an advance (AdvanceUID 0) or change one awaiting approval (Message, the refreshed page and Stats)" })
  async save(@Body() dto: AdvanceFormDto, @Req() req: Request) {
    return ciSuccess(await this.attendance.saveAdvance(writeContext(dto, req), { ...dto }));
  }

  @Post("approve")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Approve a requested advance and post its journal (Message, the refreshed page and Stats)" })
  async approve(@Body() dto: AdvanceIdDto, @Req() req: Request) {
    return ciSuccess(await this.attendance.approveAdvance(writeContext(dto, req), { ...dto }));
  }

  @Post("reject")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Reject a requested advance (Message, the refreshed page and Stats)" })
  async reject(@Body() dto: AdvanceIdDto, @Req() req: Request) {
    return ciSuccess(await this.attendance.rejectAdvance(writeContext(dto, req), { ...dto }));
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete an advance; an approved one's journal is reversed (Message, the refreshed page and Stats)" })
  async delete(@Body() dto: AdvanceIdDto, @Req() req: Request) {
    return ciSuccess(await this.attendance.deleteAdvance(writeContext(dto, req), { ...dto }));
  }
}

/** CI3 Payroll controller. */
@ApiTags("HRMS - Payroll")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/payroll")
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get("getPageData")
  @ApiOperation({ summary: `Page data: page 1 (${LIST}) and PayrollStats` })
  async getPageData(@Query() dto: HrmsListDto) {
    return ciSuccess(await this.payroll.payrollPageData(dto.orgId, rowLimitOf(dto)));
  }

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam(PAGE_PARAM)
  @ApiOperation({ summary: `One list page; Filter JSON { Status or PayrollStatus, Year } (${LIST})` })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: HrmsListDto) {
    return ciSuccess(await this.payroll.payrollPage(dto.orgId, pageOf(pageNo, dto), rowLimitOf(dto), filterOf(dto.Filter)));
  }

  @Get("getProcessData")
  @ApiOperation({ summary: "Process page data: EmployeeCount, CurrentMonth, CurrentYear" })
  async getProcessData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.payroll.processPageData(dto.orgId));
  }

  @Get("getPayrollEmployees")
  @ApiOperation({ summary: "Each employee's salary for Month / Year (Lines = Employees, WorkDays, Existing, ExistStatus)" })
  async getPayrollEmployees(@Query() dto: PayrollEmployeesDto) {
    return ciSuccess(await this.payroll.payrollEmployees(dto.orgId, dto.branchId ?? 1, { ...dto }));
  }

  @Post("savePayroll")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save the month's run (Draft or Processed) with its lines, recover advances and post the journal (PayrollUID, Message)" })
  async savePayroll(@Body() dto: PayrollSaveDto, @Req() req: Request) {
    return ciSuccess(await this.payroll.savePayroll(writeContext(dto, req), { ...dto }));
  }

  @Post("updateStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Set a run's status; Cancelled reverses its journal" })
  async updateStatus(@Body() dto: PayrollStatusDto, @Req() req: Request) {
    return ciSuccess(await this.payroll.updateStatus(writeContext(dto, req), { ...dto }));
  }

  @Post("markPaid")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark a processed run as Paid" })
  async markPaid(@Body() dto: PayrollIdDto, @Req() req: Request) {
    return ciSuccess(await this.payroll.markPaid(writeContext(dto, req), { ...dto }));
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a run that is not Paid: its lines, the advance it recovered (given back) and its journal" })
  async delete(@Body() dto: PayrollIdDto, @Req() req: Request) {
    return ciSuccess(await this.payroll.deletePayroll(writeContext(dto, req), { ...dto }));
  }

  @Get("viewPayroll/:payrollUID")
  @ApiOperation({ summary: "A run and its lines (Payroll, PayrollLines)" })
  async viewPayroll(@Param("payrollUID", ParseIntPipe) payrollUID: number, @Query() dto: OrgContextDto) {
    return ciSuccess(await this.payroll.payrollDetail(dto.orgId, payrollUID));
  }
}

/** CI3 Payslips controller. */
@ApiTags("HRMS - Payslips")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/payslips")
export class PayslipsController {
  constructor(private readonly payroll: PayrollService) {}

  @Get("getPageData")
  @ApiOperation({ summary: `Page data: page 1 (${LIST}) and EmployeeList` })
  async getPageData(@Query() dto: HrmsListDto) {
    return ciSuccess(await this.payroll.payslipPageData(dto.orgId, rowLimitOf(dto)));
  }

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam(PAGE_PARAM)
  @ApiOperation({ summary: `One list page; Filter JSON { EmployeeUID, Month, Year } (${LIST})` })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: HrmsListDto) {
    return ciSuccess(await this.payroll.payslipPage(dto.orgId, pageOf(pageNo, dto), rowLimitOf(dto), filterOf(dto.Filter)));
  }

  @Get("viewPayslip/:payrollLineUID")
  @ApiOperation({ summary: "One payslip for the view and print pages (Slip, OrgInfo)" })
  async viewPayslip(@Param("payrollLineUID", ParseIntPipe) payrollLineUID: number, @Query() dto: OrgContextDto) {
    return ciSuccess(await this.payroll.payslip(dto.orgId, payrollLineUID));
  }
}
