import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

// The user's own records on the profile page: table and primary key
export const USER_RECORDS = {
  emergency: { table: "Users.UserEmergencyContactTbl", pk: "EmgContactUID" },
  education: { table: "Users.UserEducationTbl", pk: "EduUID" },
  experience: { table: "Users.UserExperienceTbl", pk: "ExpUID" },
  bank: { table: "Users.UserBankDetailsTbl", pk: "BankDetailUID" },
  expense: { table: "Users.UserExpenseTbl", pk: "ExpenseUID" },
  signature: { table: "Users.UserSignaturesTbl", pk: "SignatureUID" },
  address: { table: "Users.UserAddressTbl", pk: "AddressUID" },
} as const;
export type UserRecord = (typeof USER_RECORDS)[keyof typeof USER_RECORDS];

// Attachment rows with the file as a full CDN URL (Url) next to the stored FilePath
const withUrl = (rows: Row[]): Row[] => rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath as string) }));

// CI3 User_model / Users_model / Signature_model queries used by Settings → Profile.
@Injectable()
export class ProfileRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // User_model::getUserByUserInfo — the logged-in user with role and organisation (password hash left out)
  async userInfo(userUID: number): Promise<Row | null> {
    const row = await this.read("Users.UserTbl as User")
      .select(
        "User.UserUID as UserUID",
        "User.FirstName as UserFirstName",
        "User.LastName as UserLastName",
        "User.UserName as UserName",
        "User.EmailAddress as UserEmailAddress",
        "User.IsLocked as IsLocked",
        "Roles.RoleUID as UserRoleUID",
        "Roles.Name as UserRoleName",
        "Org.OrgUID as UserOrgUID",
        "User.BranchUID as BranchUID",
        "Org.Logo as UserOrgLogo",
        "Org.CountryCode as UserOrgCCode",
        "Org.CountryISO2 as UserOrgCISO2",
        "Org.Name as UserOrgName",
        "Org.BrandName as UserOrgBrandName",
        "Org.MobileNumber as UserOrgMobile",
        "Timezone.Timezone as Timezone",
        "User.CountryCode as UserCountryCode",
        "User.CountryISO2 as UserCountryISO2",
        "User.MobileNumber as UserMobileNumber",
        "User.Image as UserImage",
        "Org.ShortCode as OrgShortCode",
        "Org.StateCode as OrgStateCode",
        "Org.StateName as OrgStateName",
        "Org.SectorUID as SectorUID"
      )
      .leftJoin("UserRole.RolesTbl as Roles", "Roles.RoleUID", "User.RoleUID")
      .leftJoin("Organisation.OrganisationTbl as Org", "Org.OrgUID", "User.OrgUID")
      .leftJoin("Global.TimezoneTbl as Timezone", "Timezone.TimezoneUID", "Org.TimezoneUID")
      .where("User.UserUID", userUID)
      .first();
    if (!row) return null;
    return { ...row, UserImage: row.UserImage ? resolveCdnUrl(row.UserImage) : null, UserOrgLogo: row.UserOrgLogo ? resolveCdnUrl(row.UserOrgLogo) : null };
  }

  // Users_model::getUserById — employee details with department, designation and reporting manager, plus addresses
  async userFull(userUID: number, orgUID: number): Promise<Row | null> {
    const user = await this.read("Users.UserTbl as u")
      .select(
        "u.UserUID", "u.EmployeeCode", "u.FirstName", "u.LastName", "u.UserName",
        "u.EmailAddress", "u.MobileNumber", "u.CountryCode", "u.CountryISO2",
        "u.HasLoginAccess",
        "u.RoleUID", "u.IsActive", "u.IsLocked", "u.LastLoginOn",
        "u.DepartmentUID", "d.DepartmentName",
        "u.DesignationUID", "ds.DesignationName",
        "u.DateOfJoining", "u.EmployeeStatus",
        "u.EmploymentType", "u.WorkEmail", "u.WorkPhone",
        "u.ProbationEndDate", "u.NoticePeriodDays",
        "u.ReportingManagerUID",
        this.read.raw("CONCAT(IFNULL(rm.FirstName,''), ' ', IFNULL(rm.LastName,'')) AS ReportingManagerName"),
        "u.LastWorkingDate", "u.ExitReason",
        "u.SalaryType", "u.BasicSalary", "u.Allowances", "u.Incentives", "u.FixedDeductions"
      )
      .leftJoin("Organisation.DepartmentTbl as d", (on) => {
        on.on("d.DepartmentUID", "u.DepartmentUID").andOnVal("d.IsDeleted", "=", 0);
      })
      .leftJoin("Organisation.DesignationTbl as ds", (on) => {
        on.on("ds.DesignationUID", "u.DesignationUID").andOnVal("ds.IsDeleted", "=", 0);
      })
      .leftJoin("Users.UserTbl as rm", (on) => {
        on.on("rm.UserUID", "u.ReportingManagerUID").andOnVal("rm.IsDeleted", "=", 0);
      })
      .where({ "u.UserUID": userUID, "u.OrgUID": orgUID, "u.IsDeleted": 0 })
      .first();
    if (!user) return null;
    return { ...user, Addresses: await this.addresses(userUID) };
  }

  // getUserAddresses — { Current, Permanent }
  async addresses(userUID: number): Promise<Record<"Current" | "Permanent", Row | null>> {
    const rows: Row[] = await this.read(USER_RECORDS.address.table)
      .select("AddressUID", "AddressType", "AddressLine1", "AddressLine2", "City", "State", "PinCode", "Country")
      .where({ UserUID: userUID, IsDeleted: 0 });
    const out: Record<"Current" | "Permanent", Row | null> = { Current: null, Permanent: null };
    for (const row of rows) out[row.AddressType as "Current" | "Permanent"] = row;
    return out;
  }

  async addressUIDForType(userUID: number, type: string): Promise<number | null> {
    const row = await this.read(USER_RECORDS.address.table).select("AddressUID").where({ UserUID: userUID, AddressType: type, IsDeleted: 0 }).first();
    return row ? Number(row.AddressUID) : null;
  }

  // getDepartmentList / getDesignationList — the organisation's and the shared (OrgUID 0) active rows
  async departments(orgUID: number): Promise<Row[]> {
    return this.orgOrSharedList("Organisation.DepartmentTbl", ["DepartmentUID", "DepartmentName"], orgUID);
  }

  async designations(orgUID: number): Promise<Row[]> {
    return this.orgOrSharedList("Organisation.DesignationTbl", ["DesignationUID", "DesignationName"], orgUID);
  }

  // getOrgUsersForDropdown — active users, for the reporting-manager select
  async orgUsers(orgUID: number): Promise<Row[]> {
    return this.read("Users.UserTbl")
      .select("UserUID", this.read.raw("CONCAT(FirstName, ' ', IFNULL(LastName,'')) AS FullName"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy("FirstName", "asc");
  }

  async roleUID(userUID: number, orgUID: number): Promise<number | null> {
    const row = await this.read("Users.UserTbl").select("RoleUID").where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 }).first();
    return row ? Number(row.RoleUID) : null;
  }

  async passwordHash(userUID: number): Promise<string | null | undefined> {
    const row = await this.read("Users.UserTbl").select("Password").where({ UserUID: userUID }).first();
    return row ? (row.Password ?? null) : undefined;
  }

  async updateUser(userUID: number, orgUID: number, data: Row): Promise<void> {
    await this.db.write("Users.UserTbl").where({ UserUID: userUID, OrgUID: orgUID }).update(data);
  }

  // getUserAttachments — profile documents
  async profileAttachments(userUID: number, orgUID: number): Promise<Row[]> {
    const rows = await this.read("Users.UserAttachmentTbl")
      .select("AttachUID", "FileName", "FilePath", "FileType", "FileSize", "DocType", "CreatedOn")
      .where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 })
      .where((qb) => qb.where("RefType", "Profile").orWhereNull("RefType"))
      .orderBy("AttachUID", "asc");
    return withUrl(rows);
  }

  // getExpenseAttachments — receipts of one expense
  async expenseAttachments(expenseUID: number, userUID: number, orgUID: number): Promise<Row[]> {
    const rows = await this.read("Users.UserAttachmentTbl")
      .select("AttachUID", "FileName", "FilePath", "FileType", "FileSize", "CreatedOn")
      .where({ RefType: "Expense", RefUID: expenseUID, UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("AttachUID", "asc");
    return withUrl(rows);
  }

  async insertAttachment(data: Row): Promise<void> {
    await this.db.write("Users.UserAttachmentTbl").insert({ IsActive: 1, IsDeleted: 0, ...data });
  }

  async deleteAttachment(where: Row): Promise<void> {
    await this.db.write("Users.UserAttachmentTbl").where(where).update({ IsDeleted: 1, IsActive: 0 });
  }

  // Signature_model::getSignatureList — default first, newest first
  async signatures(userUID: number, orgUID: number): Promise<Row[]> {
    return this.read(USER_RECORDS.signature.table)
      .select("SignatureUID", "Label", "SignatureType", "ImagePath", "DrawData", "MimeType", "FileSize", "Width", "Height", "IsDefault", "CreatedOn")
      .where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy([
        { column: "IsDefault", order: "desc" },
        { column: "CreatedOn", order: "desc" },
      ]);
  }

  // Signature_model::getSignatureByUID — ownership check
  async signatureExists(signatureUID: number, userUID: number): Promise<boolean> {
    return !!(await this.read(USER_RECORDS.signature.table).select("SignatureUID").where({ SignatureUID: signatureUID, UserUID: userUID, IsDeleted: 0 }).first());
  }

  async emergencyContacts(userUID: number): Promise<Row[]> {
    return this.read(USER_RECORDS.emergency.table)
      .select("EmgContactUID", "Name", "Relationship", "PhoneNumber", "EmailAddress", "AddressLine1", "AddressLine2", "City", "State", "Country", "IsPrimary")
      .where({ UserUID: userUID, IsDeleted: 0 })
      .orderBy([
        { column: "IsPrimary", order: "desc" },
        { column: "EmgContactUID", order: "asc" },
      ]);
  }

  async education(userUID: number): Promise<Row[]> {
    return this.read(USER_RECORDS.education.table)
      .select("EduUID", "Institution", "Degree", "FieldOfStudy", "CGPA", "DateOfCompletion")
      .where({ UserUID: userUID, IsDeleted: 0 })
      .orderBy("EduUID", "asc");
  }

  async experience(userUID: number): Promise<Row[]> {
    return this.read(USER_RECORDS.experience.table)
      .select("ExpUID", "EmployerName", "JobTitle", "StartDate", "EndDate", "JobDescription")
      .where({ UserUID: userUID, IsDeleted: 0 })
      .orderBy("StartDate", "desc");
  }

  async bankDetails(userUID: number): Promise<Row | null> {
    const row = await this.read(USER_RECORDS.bank.table)
      .select("BankDetailUID", "BankName", "BranchName", "IFSCCode", "AccountNumber", "AccountType", "AccountHolder", "UpiId", "UpiNumber")
      .where({ UserUID: userUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  async expenses(userUID: number, orgUID: number): Promise<Row[]> {
    return this.read(USER_RECORDS.expense.table)
      .select("ExpenseUID", "ReimbursementType", "Category", "Merchant", "Amount", "ExpenseDate", "Reference", "Description", "ReceiptPath")
      .where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("ExpenseDate", "desc");
  }

  /** Update one of the user's own records (uid > 0) or add it; returns its id. */
  async saveUserRecord(record: UserRecord, uid: number, userUID: number, data: Row, extraInsert: Row = {}): Promise<number> {
    if (uid > 0) {
      await this.db.write(record.table).where({ [record.pk]: uid, UserUID: userUID }).update({ ...data, UpdatedBy: userUID });
      return uid;
    }
    const [id] = await this.db
      .write(record.table)
      .insert({ ...data, ...extraInsert, UserUID: userUID, IsActive: 1, IsDeleted: 0, CreatedBy: userUID, UpdatedBy: userUID });
    return Number(id);
  }

  /** Update rows of the user's own records matching `where` (always limited to the user). */
  async updateUserRecords(record: UserRecord, userUID: number, where: Row, data: Row, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)(record.table).where({ ...where, UserUID: userUID }).update(data);
  }

  async insertUserRecord(record: UserRecord, data: Row): Promise<number> {
    const [id] = await this.db.write(record.table).insert(data);
    return Number(id);
  }

  private orgOrSharedList(table: string, columns: string[], orgUID: number): Promise<Row[]> {
    return this.read(table)
      .select(columns)
      .where((qb) => qb.where("OrgUID", orgUID).orWhere("OrgUID", 0))
      .where({ IsDeleted: 0, IsActive: 1 })
      .orderBy(columns[1], "asc");
  }
}
