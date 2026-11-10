import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postValue } from "../../core/utils/form-values";
import { Filter, filterOf, isDate, Page, Row, todayIn } from "./hrms-common";
import { HrmsMastersRepository, MasterKind } from "./hrms-masters.repository";

type Form = Record<string, unknown>;

const LABEL: Record<MasterKind, { name: string; field: string; uid: string; title: string }> = {
  department: { name: "Department", field: "DepartmentName", uid: "DepartmentUID", title: "Department name" },
  designation: { name: "Designation", field: "DesignationName", uid: "DesignationUID", title: "Designation name" },
};

const text = (form: Form, key: string) => String(postValue(form, key) ?? "").trim();

/** CI3 Departments, Designations and Holidays controllers. Every list answer is { Data, TotalCount, PageNo, RowLimit }. */
@Injectable()
export class HrmsMastersService {
  constructor(
    private readonly repo: HrmsMastersRepository,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // ── Departments / Designations ────────────────────────────────────────────────

  async masterPage(kind: MasterKind, orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter): Promise<Page> {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const { rows, total } = await this.repo.masterPage(kind, orgUID, filter, limit, (page - 1) * limit);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit };
  }

  async masterList(kind: MasterKind, orgUID: number) {
    await this.orgSettings.get(orgUID);
    return { Data: await this.repo.masterList(kind, orgUID) };
  }

  // save — create (UID 0) or update the org's own row
  async masterSave(kind: MasterKind, ctx: WriteContext, form: Form) {
    const l = LABEL[kind];
    const uid = postInt(form, l.uid);
    // CI3 let any org rewrite the description of a system row (OrgUID 0), which every org shares
    if (uid > 0 && Number((await this.repo.masterFind(kind, uid))?.OrgUID ?? -1) === 0) {
      throw new CiValidationError(`System ${l.name.toLowerCase()}s are shared by every organisation and cannot be changed.`);
    }
    const name = text(form, l.field);
    if (!name) throw new CiValidationError(`${l.title} is required.`);
    if (name.length > 100) throw new CiValidationError(`${l.title} must be 100 characters or fewer.`);

    const data: Row = { OrgUID: ctx.orgUID, [l.field]: name, Description: text(form, "Description"), IsActive: 1, UpdatedBy: ctx.userUID };
    if (uid === 0) {
      await this.repo.masterInsert(kind, { ...data, CreatedBy: ctx.userUID });
    } else if ((await this.repo.masterUpdate(kind, ctx.orgUID, uid, data)) === 0) {
      // CI3 reported success when the row was another org's
      throw new CiValidationError(`${l.name} not found.`);
    }
    return { Message: uid ? "Updated." : "Created.", ...(await this.refreshed(kind, ctx.orgUID, form)) };
  }

  async masterDelete(kind: MasterKind, ctx: WriteContext, form: Form) {
    const l = LABEL[kind];
    const uid = postInt(form, l.uid);
    if (!uid) throw new CiValidationError("Invalid.");
    if ((await this.repo.masterUpdate(kind, ctx.orgUID, uid, { IsDeleted: 1, UpdatedBy: ctx.userUID })) === 0) {
      throw new CiValidationError(`${l.name} not found.`);
    }
    return { Message: "Deleted.", ...(await this.refreshed(kind, ctx.orgUID, form)) };
  }

  private async refreshed(kind: MasterKind, orgUID: number, form: Form) {
    return this.masterPage(kind, orgUID, postInt(form, "CurrentPage") || 1, postInt(form, "RowLimit") || undefined, filterOf(form.Filter));
  }

  // ── Holidays ─────────────────────────────────────────────────────────────────

  // getPageDetails — the current year (org timezone) when no Year is given
  async holidayPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: Filter): Promise<Page & { CurrentYear: string }> {
    const settings = await this.orgSettings.get(orgUID);
    const currentYear = todayIn(settings.Timezone).slice(0, 4);
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const { rows, total } = await this.repo.holidayPage(orgUID, { ...filter, Year: filter.Year || currentYear }, limit, (page - 1) * limit);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit, CurrentYear: currentYear };
  }

  async holidaySave(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "HolidayUID");
    const name = text(form, "HolidayName");
    const date = text(form, "HolidayDate");
    if (!name) throw new CiValidationError("Holiday name is required.");
    if (name.length > 150) throw new CiValidationError("Holiday name must be 150 characters or fewer.");
    if (!date) throw new CiValidationError("Holiday date is required.");
    if (!isDate(date)) throw new CiValidationError("Holiday date is not a valid date.");

    const data: Row = {
      OrgUID: ctx.orgUID,
      HolidayName: name,
      HolidayDate: date,
      Description: text(form, "Description"),
      IsOptional: postInt(form, "IsOptional") ? 1 : 0,
      IsActive: 1,
      UpdatedBy: ctx.userUID,
    };
    if (uid === 0) {
      await this.repo.holidayInsert({ ...data, CreatedBy: ctx.userUID });
    } else if ((await this.repo.holidayUpdate(ctx.orgUID, uid, data)) === 0) {
      throw new CiValidationError("Holiday not found.");
    }
    return { Message: uid ? "Updated." : "Holiday added.", ...(await this.holidayRefreshed(ctx.orgUID, form)) };
  }

  async holidayDelete(ctx: WriteContext, form: Form) {
    const uid = postInt(form, "HolidayUID");
    if (!uid) throw new CiValidationError("Invalid.");
    if ((await this.repo.holidayUpdate(ctx.orgUID, uid, { IsDeleted: 1, UpdatedBy: ctx.userUID })) === 0) {
      throw new CiValidationError("Holiday not found.");
    }
    return { Message: "Deleted.", ...(await this.holidayRefreshed(ctx.orgUID, form)) };
  }

  private holidayRefreshed(orgUID: number, form: Form) {
    return this.holidayPage(orgUID, postInt(form, "CurrentPage") || 1, postInt(form, "RowLimit") || undefined, filterOf(form.Filter));
  }

  // getEmployeeDropdownList — shared by the attendance, payslip and salary-advance pages
  employees(orgUID: number) {
    return this.repo.employees(orgUID);
  }
}
