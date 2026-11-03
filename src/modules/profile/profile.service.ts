import { Injectable } from "@nestjs/common";
import { hashPassword, nowDateTime, verifyPassword } from "../../common/utils/php-compat";
import { timestampedUploadName, uniqueUploadName } from "../../common/utils/upload-names";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postFlag, postInt, postString } from "../../core/utils/form-values";
import { validationErrorsText } from "../../core/validation/ci-form-validator";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { ProfileAddressDto, ProfileDetailsDto, ProfileWorkInfoDto } from "./dto/profile.dto";
import { dateOrNull, EMPLOYMENT_TYPES, MAX_UPLOAD_BYTES, passwordFormValidator, textOrNull, WORK_STATUSES } from "./profile-form";
import { ProfileSessionService } from "./profile-session.service";
import { ProfileRepository, Row, USER_RECORDS } from "./profile.repository";

// The CI3 Profile controller: page data, details, work information, addresses and documents.
@Injectable()
export class ProfileService {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly fileUpload: FileUploadService,
    private readonly session: ProfileSessionService
  ) {}

  // index — what the CI3 page renders
  async getPageData(orgUID: number, userUID: number) {
    const [userInfo, userFullData, userAttachments, departments, designations, orgUsers, bankDetails] = await Promise.all([
      this.repo.userInfo(userUID),
      this.repo.userFull(userUID, orgUID),
      this.repo.profileAttachments(userUID, orgUID),
      this.repo.departments(orgUID),
      this.repo.designations(orgUID),
      this.repo.orgUsers(orgUID),
      this.repo.bankDetails(userUID),
    ]);
    if (!userInfo) throw new CiValidationError("User not found.");
    return {
      userInfo,
      userFullData,
      userAttachments,
      DepartmentsList: departments,
      DesignationsList: designations,
      OrgUsersList: orgUsers,
      bankDetails,
    };
  }

  // updateProfileDetails — name, mobile, photo and optionally the password; then the session is refreshed
  async updateDetails(form: ProfileDetailsDto, ctx: WriteContext, photo: Express.Multer.File | undefined, sessionKey: string | undefined) {
    const { orgUID, userUID } = ctx;
    const passwordFilled = ["oldPassword", "newPassword", "confirmPassword"].some((field) => String(form[field as keyof ProfileDetailsDto] ?? "") !== "");
    if (passwordFilled) {
      const errors = passwordFormValidator.validate(form as unknown as Record<string, unknown>);
      if (Object.keys(errors).length > 0) throw new CiValidationError(validationErrorsText(errors));
    }

    const changePassword = postInt(form, "IsPasswordUpdate") === 1;
    const oldPassword = String(form.oldPassword ?? "");
    const newPassword = String(form.newPassword ?? "");
    if (changePassword) {
      const stored = await this.repo.passwordHash(userUID);
      if (stored === undefined) throw new CiValidationError("User not found");
      if (!(await verifyPassword(oldPassword, stored))) throw new CiValidationError("Old password is incorrect");
      if (newPassword !== String(form.confirmPassword ?? "")) throw new CiValidationError("New password and Confirm password do not match");
      if (oldPassword === newPassword) throw new CiValidationError("Old Password and New Password cannot be the same");
    }

    const data: Row = {
      FirstName: postString(form, "fistName"),
      LastName: postString(form, "lastName"),
      CountryCode: postString(form, "CountryCode"),
      CountryISO2: postString(form, "CountryISO2"),
      MobileNumber: postString(form, "MobileNumber"),
      UpdatedBy: userUID,
    };
    if (postFlag(form, "ImageRemoved") === 1) data.Image = null;
    // Stored as bcrypt, the format CI3's login and password screens use (CI3's profile form wrote base64)
    if (changePassword) {
      data.Password = await hashPassword(newPassword);
      data.PasswordChangedOn = nowDateTime();
    }
    await this.repo.updateUser(userUID, orgUID, data);

    if (photo) {
      const upload = await this.fileUpload.upload(`profile/images/${uniqueUploadName(photo.originalname)}`, photo.buffer, photo.mimetype);
      await this.repo.updateUser(userUID, orgUID, { Image: "/" + upload.Path });
    }

    await this.session.refresh(sessionKey);
    return { Message: "Updated Successfully" };
  }

  // saveProfileWorkInfo — the role 1 (owner) account always stays Active
  async saveWorkInfo(form: ProfileWorkInfoDto, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    let status = String(form.EmployeeStatus ?? "Active").trim();
    if (!WORK_STATUSES.includes(status)) status = "Active";
    if ((await this.repo.roleUID(userUID, orgUID)) === 1) status = "Active";
    const employmentType = String(form.EmploymentType ?? "").trim();
    const managerUID = postInt(form, "ReportingManagerUID");
    const notice = String(form.NoticePeriodDays ?? "").trim();

    const data: Row = {
      UpdatedBy: userUID,
      EmployeeStatus: status,
      EmploymentType: EMPLOYMENT_TYPES.includes(employmentType) ? employmentType : null,
      WorkEmail: textOrNull(form.WorkEmail),
      WorkPhone: textOrNull(form.WorkPhone),
      NoticePeriodDays: notice === "" ? null : postInt(form, "NoticePeriodDays"),
      ReportingManagerUID: managerUID > 0 && managerUID !== userUID ? managerUID : null,
      ExitReason: textOrNull(form.ExitReason),
      ProbationEndDate: dateOrNull(form.ProbationEndDate),
      LastWorkingDate: dateOrNull(form.LastWorkingDate),
    };
    if (postInt(form, "DepartmentUID") > 0) data.DepartmentUID = postInt(form, "DepartmentUID");
    if (postInt(form, "DesignationUID") > 0) data.DesignationUID = postInt(form, "DesignationUID");
    const joining = dateOrNull(form.DateOfJoining);
    if (joining) data.DateOfJoining = joining;

    await this.repo.updateUser(userUID, orgUID, data);
    return { Message: "Work information saved successfully." };
  }

  // saveProfileAddress — Current and Permanent; an address with nothing filled is skipped
  async saveAddresses(form: ProfileAddressDto, ctx: WriteContext) {
    const { userUID } = ctx;
    let saved = 0;
    for (const [type, prefix] of [["Current", "Curr"], ["Permanent", "Perm"]] as const) {
      const field = (name: string) => String(form[`${prefix}${name}` as keyof ProfileAddressDto] ?? "").trim();
      const line1 = field("AddressLine1");
      const city = field("City");
      const state = field("State");
      const pin = field("PinCode");
      if (!line1 && !city && !state && !pin) continue;

      const data: Row = {
        AddressType: type,
        AddressLine1: line1 || null,
        AddressLine2: field("AddressLine2") || null,
        City: city || null,
        State: state || null,
        PinCode: pin || null,
        Country: field("Country") || "India",
        IsActive: 1,
        IsDeleted: 0,
      };
      const existing = await this.repo.addressUIDForType(userUID, type);
      await this.repo.saveUserRecord(USER_RECORDS.address, existing ?? 0, userUID, data);
      saved++;
    }
    return { Message: saved ? "Address saved successfully." : "Nothing to save." };
  }

  // saveProfileAttachment — one document (max 5 MB) under employees/{user}/
  async addProfileAttachment(ctx: WriteContext, file: Express.Multer.File | undefined, docType: string | undefined) {
    const { orgUID, userUID } = ctx;
    await this.storeAttachment(ctx, file, `employees/${userUID}/`, { RefType: "Profile", RefUID: userUID, DocType: (docType ?? "").trim() || "General" });
    return { Message: "File uploaded successfully.", Attachments: await this.repo.profileAttachments(userUID, orgUID) };
  }

  // deleteProfileAttachment
  async deleteProfileAttachment(ctx: WriteContext, attachUID: number) {
    const { orgUID, userUID } = ctx;
    if (attachUID <= 0) throw new CiValidationError("Invalid attachment.");
    await this.repo.deleteAttachment({ AttachUID: attachUID, UserUID: userUID, OrgUID: orgUID });
    return { Message: "Deleted.", Attachments: await this.repo.profileAttachments(userUID, orgUID) };
  }

  // getExpenseAttachments
  async getExpenseAttachments(orgUID: number, userUID: number, expenseUID: number) {
    if (expenseUID <= 0) throw new CiValidationError("Invalid expense.");
    return { Attachments: await this.repo.expenseAttachments(expenseUID, userUID, orgUID) };
  }

  // saveExpenseAttachment — one receipt (max 5 MB) for an expense
  async addExpenseAttachment(ctx: WriteContext, expenseUID: number, file: Express.Multer.File | undefined) {
    const { orgUID, userUID } = ctx;
    if (expenseUID <= 0) throw new CiValidationError("Invalid expense.");
    await this.storeAttachment(ctx, file, `employees/${userUID}/expenses/`, { RefType: "Expense", RefUID: expenseUID, DocType: "Receipt" });
    return { Message: "Receipt uploaded.", Attachments: await this.repo.expenseAttachments(expenseUID, userUID, orgUID) };
  }

  // deleteExpenseAttachment
  async deleteExpenseAttachment(ctx: WriteContext, expenseUID: number, attachUID: number) {
    const { orgUID, userUID } = ctx;
    if (attachUID <= 0) throw new CiValidationError("Invalid attachment.");
    if (expenseUID <= 0) throw new CiValidationError("Invalid expense.");
    await this.repo.deleteAttachment({ AttachUID: attachUID, RefType: "Expense", RefUID: expenseUID, UserUID: userUID, OrgUID: orgUID });
    return { Message: "Receipt deleted.", Attachments: await this.repo.expenseAttachments(expenseUID, userUID, orgUID) };
  }

  /** Uploads one file to `folder` and records it in Users.UserAttachmentTbl for ownerUID (default: the caller). */
  async storeAttachment(ctx: WriteContext, file: Express.Multer.File | undefined, folder: string, ref: Row, index?: number, ownerUID = ctx.userUID): Promise<void> {
    if (!file) throw new CiValidationError("No file received or upload error.");
    if (file.size > MAX_UPLOAD_BYTES) throw new CiValidationError("File size must be under 5 MB.");
    const upload = await this.fileUpload.upload(folder + timestampedUploadName(file.originalname, index), file.buffer, file.mimetype);
    await this.repo.insertAttachment({
      UserUID: ownerUID,
      OrgUID: ctx.orgUID,
      ...ref,
      FileName: file.originalname,
      FilePath: "/" + upload.Path.replace(/^\/+/, ""),
      FileType: file.mimetype,
      FileSize: file.size,
      CreatedBy: ctx.userUID,
    });
  }
}
