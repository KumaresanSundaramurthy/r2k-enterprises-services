import { Injectable, Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { Knex } from "knex";
import { appUrl } from "../../auth/utils/app-url";
import { MailService } from "../../common/mail/mail.service";
import { RedisService } from "../../common/redis/redis.service";
import { escapeHtml } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postIntList, postJsonArray } from "../../core/utils/form-values";
import { UserAccessService } from "../../libraries/user-access/user-access.service";
import { BranchesRepository } from "../branches/branches.repository";
import { dateOrNull } from "../profile/profile-form";
import { ProfileRepository } from "../profile/profile.repository";
import { ProfileService } from "../profile/profile.service";
import { RolesRepository } from "../roles/roles.repository";
import { SessionSyncService } from "../session-sync/session-sync.service";
import { Row, UserListFilter, UsersRepository } from "./users.repository";

type Form = Record<string, unknown>;

const STATUS_SLUGS: Record<string, string> = { all: "All", active: "Active", resigned: "Resigned", terminated: "Terminated", onleave: "OnLeave" };
const EMPLOYEE_STATUSES = ["Active", "Resigned", "Terminated", "OnLeave"];
const SALARY_TYPES = ["Monthly", "Daily", "Hourly"];
const SALARY_COLUMNS = ["BasicSalary", "Allowances", "Incentives", "FixedDeductions"];
// org-users Redis cache lifetime (CI3: one day)
const ORG_USERS_TTL = 86400;

const text = (form: Form, key: string): string => String(form[key] ?? "").trim();

// Salary columns removed for callers who may not see them (CI3 _canSeeSalary)
function withoutSalary<T extends Row | null>(row: T, canSee: boolean): T {
  if (!row || canSee) return row;
  const copy = { ...row };
  for (const column of SALARY_COLUMNS) delete copy[column];
  return copy as T;
}

// Settings → Manage Users (CI3 Users controller): staff records, logins, addresses, documents and branch access.
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly repo: UsersRepository,
    private readonly profiles: ProfileRepository,
    private readonly profile: ProfileService,
    private readonly roles: RolesRepository,
    private readonly branches: BranchesRepository,
    private readonly access: UserAccessService,
    private readonly orgSettings: OrgSettingsService,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    private readonly sessionSync: SessionSyncService
  ) {}

  // index — dropdowns, next employee code, stats and the status the page opens with (?status=active …)
  async getPageData(orgUID: number, callerUID: number, statusSlug: string | undefined, langCode: string) {
    const [roles, departments, designations, nextCode, stats, canSeeSalary, branches] = await Promise.all([
      this.roles.list(orgUID),
      this.profiles.departments(orgUID),
      this.profiles.designations(orgUID),
      this.nextEmployeeCode(orgUID),
      this.repo.stats(orgUID),
      this.access.canSeeSalary(orgUID, callerUID),
      this.branches.listActive(orgUID, langCode),
    ]);
    return {
      RolesList: roles,
      DepartmentList: departments,
      DesignationList: designations,
      NextEmpCode: nextCode,
      StaffStats: stats,
      CanSeeSalary: canSeeSalary,
      BranchesList: branches,
      InitStatus: STATUS_SLUGS[String(statusSlug ?? "all").trim().toLowerCase()] ?? "All",
    };
  }

  // getPageDetails — one page of staff (the CI3 JS builds the rows) with the header stats
  async getPage(orgUID: number, callerUID: number, pageNo: number, rowLimit: number | undefined, filter: UserListFilter) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const [rows, total, stats, canSeeSalary] = await Promise.all([
      this.repo.list(orgUID, filter, limit, (pageNo - 1) * limit),
      this.repo.count(orgUID, filter),
      this.repo.stats(orgUID),
      this.access.canSeeSalary(orgUID, callerUID),
    ]);
    return { Data: rows.map((row) => withoutSalary(row, canSeeSalary)), TotalCount: total, PageNo: pageNo, RowLimit: limit, Stats: stats };
  }

  // getUserDetail — the edit modal: user, documents and branch access
  async getDetail(orgUID: number, callerUID: number, userUID: number) {
    if (userUID <= 0) throw new CiValidationError("Invalid user.");
    const [user, attachments, branchAccess, canSeeSalary] = await Promise.all([
      this.profiles.userFull(userUID, orgUID),
      this.profiles.profileAttachments(userUID, orgUID),
      this.repo.branchAccess(orgUID, userUID),
      this.access.canSeeSalary(orgUID, callerUID),
    ]);
    if (!user) throw new CiValidationError("User not found.");
    return { Data: withoutSalary(user, canSeeSalary), Attachments: attachments, BranchAccess: branchAccess };
  }

  // saveUserAttachment — a document for one staff member (max 5 MB)
  async addAttachment(ctx: WriteContext, userUID: number, file: Express.Multer.File | undefined, docType: string | undefined) {
    if (userUID <= 0) throw new CiValidationError("Invalid user.");
    await this.profile.storeAttachment(ctx, file, `employees/${userUID}/`, { DocType: (docType ?? "").trim() || "General" }, undefined, userUID);
    return { Message: "File uploaded successfully.", Attachments: await this.profiles.profileAttachments(userUID, ctx.orgUID) };
  }

  // deleteUserAttachment
  async deleteAttachment(ctx: WriteContext, userUID: number, attachUID: number) {
    if (attachUID <= 0) throw new CiValidationError("Invalid attachment.");
    await this.profiles.deleteAttachment({ AttachUID: attachUID, OrgUID: ctx.orgUID });
    return { Message: "Deleted.", Attachments: await this.profiles.profileAttachments(userUID, ctx.orgUID) };
  }

  // toggleStatus — the Super Admin account always stays as it is
  async toggleStatus(form: Form, ctx: WriteContext) {
    const userUID = postInt(form, "UserUID");
    if (userUID <= 0) throw new CiValidationError("Invalid user.");
    if ((await this.repo.roleName(ctx.orgUID, userUID)) === "Super Admin") throw new CiValidationError("Super Admin account status cannot be changed.");
    await this.repo.updateUser(ctx.orgUID, userUID, { IsActive: postInt(form, "IsActive"), UpdatedBy: ctx.userUID });
    return { Message: "Status updated successfully.", ...(await this.listResponse(ctx, form)) };
  }

  // saveUser — staff record, login access, addresses and branch access in one transaction
  async save(form: Form, ctx: WriteContext, sessionKey: string | undefined) {
    const { orgUID, userUID: callerUID } = ctx;
    let userUID = postInt(form, "UserUID");
    const isCreate = userUID === 0;
    const hasLogin = postInt(form, "HasLoginAccess") ? 1 : 0;
    const firstName = text(form, "FirstName");
    const email = text(form, "Email");
    const userName = text(form, "UserName");
    const roleUID = postInt(form, "RoleUID") || null;
    if (!firstName) throw new CiValidationError("First name is required.");
    if (hasLogin) {
      if (isCreate && !userName) throw new CiValidationError("Username is required for login users.");
      if (isCreate && !email) throw new CiValidationError("Email address is required for login users.");
      if (!roleUID) throw new CiValidationError("Role is required for login users.");
    }
    const departmentUID = postInt(form, "DepartmentUID") || null;
    const designationUID = postInt(form, "DesignationUID") || null;
    if (!departmentUID) throw new CiValidationError("Department is required.");
    if (!designationUID) throw new CiValidationError("Designation is required.");

    const canSeeSalary = await this.access.canSeeSalary(orgUID, callerUID);
    const employeeStatus = String(form.EmployeeStatus ?? "");
    const salaryType = String(form.SalaryType ?? "");
    const data: Row = {
      FirstName: firstName,
      LastName: text(form, "LastName"),
      MobileNumber: text(form, "Mobile") || null,
      CountryCode: text(form, "CountryCode") || null,
      CountryISO2: text(form, "CountryISO2") || "IN",
      HasLoginAccess: hasLogin,
      RoleUID: hasLogin ? roleUID : null,
      IsActive: hasLogin ? (form.IsActive === undefined ? 1 : postInt(form, "IsActive")) : 1,
      OrgUID: orgUID,
      BranchUID: ctx.branchUID,
      DepartmentUID: departmentUID,
      DesignationUID: designationUID,
      DateOfJoining: text(form, "DateOfJoining") || null,
      EmployeeStatus: EMPLOYEE_STATUSES.includes(employeeStatus) ? employeeStatus : "Active",
      SalaryType: SALARY_TYPES.includes(salaryType) ? salaryType : "Monthly",
      IsDeleted: 0,
    };
    if (canSeeSalary) for (const column of SALARY_COLUMNS) data[column] = Number(form[column] ?? 0) || 0;
    if (hasLogin) {
      const expiry = dateOrNull(form.LoginExpiryDateTime);
      data.LoginExpiryDateTime = expiry ? `${expiry} 23:59:59` : null;
    }

    let setupToken: string | null = null;
    await this.db.write.transaction(async (trx) => {
      if (isCreate) {
        const { prefix, separator, digits } = await this.repo.employeeCodeFormat(orgUID);
        const number = await this.repo.claimEmployeeNumber(orgUID, trx);
        setupToken = hasLogin ? randomBytes(32).toString("hex") : null;
        userUID = await this.repo.insertUser(trx, {
          ...data,
          EmployeeCode: `${prefix}${separator}${String(number).padStart(digits, "0")}`,
          Password: "",
          IsPasswordSet: 0,
          UserName: hasLogin ? userName : null,
          EmailAddress: hasLogin ? email : email || null,
          PasswordSetToken: setupToken,
          CreatedBy: callerUID,
          CreatedOn: trx.fn.now(),
        });
      } else {
        const update: Row = { ...data, EmployeeCode: text(form, "EmployeeCode") || null, UpdatedBy: callerUID, UpdatedOn: trx.fn.now() };
        if (hasLogin) update.IsLocked = postInt(form, "IsLocked");
        await this.repo.updateUser(orgUID, userUID, update, trx);
      }
      await this.saveAddresses(trx, form, userUID, callerUID);
      const branchAccess = postJsonArray<{ BranchUID?: unknown; IsDefault?: unknown }>(form, "BranchAccessJson");
      if (branchAccess.length > 0) await this.repo.replaceBranchAccess(trx, orgUID, userUID, branchAccess);
    });

    let message = isCreate ? "Staff record created successfully." : "Staff record updated successfully.";
    if (setupToken && email) {
      await this.sendPasswordSetupEmail(email, firstName, setupToken);
      message = `Staff record created. A password setup link has been sent to ${email}.`;
    }
    await this.refreshLoginUsersCache(orgUID);
    if (!isCreate && userUID === callerUID) await this.sessionSync.refresh(sessionKey);
    return { Message: message, UID: userUID, ...(await this.listResponse(ctx, form)) };
  }

  // updateLanguage — the caller's UI language, also in the session
  async updateLanguage(ctx: WriteContext, language: string, sessionKey: string | undefined) {
    const lang = language.trim();
    if (!["en", "ta"].includes(lang)) throw new CiValidationError("Invalid language code.");
    await this.repo.updateUser(ctx.orgUID, ctx.userUID, { UILanguage: lang });
    await this.sessionSync.patch(sessionKey, (session) => ({ ...session, User: { ...session.User, UILanguage: lang } }));
    return { Message: "Language updated successfully." };
  }

  // getEmployeeList
  async getEmployees(orgUID: number) {
    return { Data: await this.repo.employeeDropdown(orgUID) };
  }

  // getOrgUsers — login users from the org-users cache (built on a miss)
  async getLoginUsers(orgUID: number) {
    const key = await this.loginUsersKey(orgUID);
    let users = await this.redis.get<Row[]>(key);
    if (!users || users.length === 0) {
      users = await this.repo.loginUsers(orgUID);
      await this.redis.set(key, users, ORG_USERS_TTL);
    }
    return { Users: users };
  }

  // _appendListResponse — the first page for the posted Filter / RowLimit, as after a change
  private async listResponse(ctx: WriteContext, form: Form) {
    const filter = UsersService.jsonObject(form.Filter) as UserListFilter;
    const page = await this.getPage(ctx.orgUID, ctx.userUID, 1, postInt(form, "RowLimit") || undefined, Object.keys(filter).length ? filter : { EmpStatus: "All" });
    return { Data: page.Data, TotalCount: page.TotalCount, RowLimit: page.RowLimit, Stats: page.Stats, NextEmpCode: await this.nextEmployeeCode(ctx.orgUID) };
  }

  // Current (Curr*) and permanent (Perm*) addresses; DelAddrUIDs are removed first
  private async saveAddresses(trx: Knex.Transaction, form: Form, userUID: number, callerUID: number): Promise<void> {
    const removed = postIntList(form, "DelAddrUIDs");
    if (removed.length > 0) {
      await trx("Users.UserAddressTbl").whereIn("AddressUID", removed).where({ UserUID: userUID }).update({ IsDeleted: 1, IsActive: 0, UpdatedBy: callerUID });
    }
    for (const [type, prefix] of [["Current", "Curr"], ["Permanent", "Perm"]] as const) {
      const field = (name: string) => text(form, `${prefix}${name}`);
      const [line1, city, state, pin] = [field("AddressLine1"), field("City"), field("State"), field("PinCode")];
      if (!line1 && !city && !state && !pin) continue;
      const data = {
        UserUID: userUID,
        AddressType: type,
        AddressLine1: line1 || null,
        AddressLine2: field("AddressLine2") || null,
        City: city || null,
        State: state || null,
        PinCode: pin || null,
        Country: "India",
        IsActive: 1,
        IsDeleted: 0,
        UpdatedBy: callerUID,
      };
      const existing = await trx("Users.UserAddressTbl").select("AddressUID").where({ UserUID: userUID, AddressType: type, IsDeleted: 0 }).first();
      if (existing) await trx("Users.UserAddressTbl").where({ AddressUID: existing.AddressUID }).update(data);
      else await trx("Users.UserAddressTbl").insert({ ...data, CreatedBy: callerUID });
    }
  }

  // getNextEmployeeCode — preview of the code the next new staff member gets
  private async nextEmployeeCode(orgUID: number): Promise<string> {
    const [{ prefix, separator, digits }, last] = await Promise.all([this.repo.employeeCodeFormat(orgUID), this.repo.lastEmployeeNumber(orgUID)]);
    return `${prefix}${separator}${String(last + 1).padStart(digits, "0")}`;
  }

  private async refreshLoginUsersCache(orgUID: number): Promise<void> {
    await this.redis.set(await this.loginUsersKey(orgUID), await this.repo.loginUsers(orgUID), ORG_USERS_TTL);
  }

  private async loginUsersKey(orgUID: number): Promise<string> {
    return this.redis.orgKey("org-users", (await this.orgSettings.get(orgUID)).OrgToken);
  }

  // _sendPasswordSetupEmail — the link to set the first password; a failed send is logged, not returned
  private async sendPasswordSetupEmail(email: string, firstName: string, token: string): Promise<void> {
    const url = appUrl(`setpassword/${token}`);
    const fromName = this.mail.fromName;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;margin:0;padding:20px;}
.btn{display:inline-block;padding:10px 24px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:6px;font-size:14px;}</style>
</head><body>
<p>Hi ${escapeHtml(firstName)},</p>
<p>Your account has been created. Please click the button below to set your password and activate your account:</p>
<p><a class="btn" href="${url}">Set My Password</a></p>
<p>If the button does not work, copy and paste this link:<br>
<a href="${url}">${url}</a></p>
<p>This link has no expiry — you can use it any time until your password is set.</p>
<p>Regards,<br>${fromName}</p>
</body></html>`;
    try {
      await this.mail.send(email, firstName, `Set Your Password — ${fromName}`, html);
    } catch (err) {
      this.logger.error(`Password setup email to ${email} failed: ${(err as Error).message}`);
    }
  }

  // Filter posted as a JSON object string or as an object
  private static jsonObject(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value === "string" && value) {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}
