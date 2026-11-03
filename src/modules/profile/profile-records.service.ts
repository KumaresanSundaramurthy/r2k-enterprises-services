import { Injectable } from "@nestjs/common";
import { phpRound } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { BankDetailsDto, EducationDto, EmergencyContactDto, ExperienceDto, ExpenseFormDto } from "./dto/profile.dto";
import { dateOrNull, REIMBURSEMENT_TYPES, textOrNull } from "./profile-form";
import { ProfileRepository, USER_RECORDS, UserRecord } from "./profile.repository";
import { ProfileService } from "./profile.service";

// Emergency contacts, bank details, education, experience and expenses on the CI3 profile page.
@Injectable()
export class ProfileRecordsService {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly db: DatabaseService,
    private readonly profile: ProfileService
  ) {}

  // ── Emergency contacts ──────────────────────────────────────────────────

  async getEmergencyContacts(userUID: number) {
    return { Contacts: await this.repo.emergencyContacts(userUID) };
  }

  // saveEmergencyContact — a primary contact clears the flag on the others
  async saveEmergencyContact(form: EmergencyContactDto, ctx: WriteContext) {
    const { userUID } = ctx;
    const uid = postInt(form, "EmgContactUID");
    const name = String(form.Name ?? "").trim();
    const relationship = String(form.Relationship ?? "").trim();
    const phone = String(form.PhoneNumber ?? "").trim();
    if (!name) throw new CiValidationError("Name is required.");
    if (!relationship) throw new CiValidationError("Relationship is required.");
    if (!phone) throw new CiValidationError("Phone number is required.");
    const isPrimary = postInt(form, "IsPrimary") ? 1 : 0;

    if (isPrimary) await this.repo.updateUserRecords(USER_RECORDS.emergency, userUID, { IsDeleted: 0 }, { IsPrimary: 0, UpdatedBy: userUID });
    await this.repo.saveUserRecord(USER_RECORDS.emergency, uid, userUID, {
      Name: name.slice(0, 100),
      Relationship: relationship.slice(0, 100),
      PhoneNumber: phone.slice(0, 20),
      EmailAddress: textOrNull(form.EmailAddress, 150),
      AddressLine1: textOrNull(form.AddressLine1, 200),
      AddressLine2: textOrNull(form.AddressLine2, 200),
      City: textOrNull(form.City, 100),
      State: textOrNull(form.State, 100),
      Country: textOrNull(form.Country, 100),
      IsPrimary: isPrimary,
    });
    return { Message: uid > 0 ? "Contact updated." : "Contact added.", Contacts: await this.repo.emergencyContacts(userUID) };
  }

  async deleteEmergencyContact(uid: number, ctx: WriteContext) {
    if (uid <= 0) throw new CiValidationError("Invalid record.");
    await this.softDelete(USER_RECORDS.emergency, uid, ctx.userUID, { IsPrimary: 0 });
    return { Message: "Contact deleted.", Contacts: await this.repo.emergencyContacts(ctx.userUID) };
  }

  async setPrimaryContact(uid: number, ctx: WriteContext) {
    const { userUID } = ctx;
    if (uid <= 0) throw new CiValidationError("Invalid contact.");
    await this.db.write.transaction(async (trx) => {
      await this.repo.updateUserRecords(USER_RECORDS.emergency, userUID, { IsDeleted: 0 }, { IsPrimary: 0, UpdatedBy: userUID }, trx);
      await this.repo.updateUserRecords(USER_RECORDS.emergency, userUID, { EmgContactUID: uid }, { IsPrimary: 1, UpdatedBy: userUID }, trx);
    });
    return { Message: "Primary contact updated.", Contacts: await this.repo.emergencyContacts(userUID) };
  }

  // ── Bank details ────────────────────────────────────────────────────────

  async getBankDetails(userUID: number) {
    return { Data: await this.repo.bankDetails(userUID) };
  }

  async saveBankDetails(form: BankDetailsDto, ctx: WriteContext) {
    await this.repo.saveUserRecord(USER_RECORDS.bank, postInt(form, "BankDetailUID"), ctx.userUID, {
      BankName: textOrNull(form.BankName, 100),
      BranchName: textOrNull(form.BranchName, 100),
      IFSCCode: textOrNull(form.IFSCCode, 50)?.toUpperCase() ?? null,
      AccountNumber: textOrNull(form.AccountNumber, 50),
      AccountType: textOrNull(form.AccountType, 20),
      AccountHolder: textOrNull(form.AccountHolder, 100),
      UpiId: textOrNull(form.UpiId, 100),
      UpiNumber: textOrNull(form.UpiNumber, 20),
    });
    return { Message: "Bank details saved.", Data: await this.repo.bankDetails(ctx.userUID) };
  }

  // ── Education & experience ──────────────────────────────────────────────

  async getEduExp(userUID: number) {
    const [education, experience] = await Promise.all([this.repo.education(userUID), this.repo.experience(userUID)]);
    return { Education: education, Experience: experience };
  }

  async saveEducation(form: EducationDto, ctx: WriteContext) {
    const uid = postInt(form, "EduUID");
    const institution = String(form.Institution ?? "").trim();
    if (!institution) throw new CiValidationError("Institution name is required.");
    await this.repo.saveUserRecord(USER_RECORDS.education, uid, ctx.userUID, {
      Institution: institution.slice(0, 200),
      Degree: textOrNull(form.Degree, 100),
      FieldOfStudy: textOrNull(form.FieldOfStudy, 100),
      CGPA: textOrNull(form.CGPA, 20),
      DateOfCompletion: dateOrNull(form.DateOfCompletion),
    });
    return { Message: uid > 0 ? "Education updated." : "Education added.", Education: await this.repo.education(ctx.userUID) };
  }

  async deleteEducation(uid: number, ctx: WriteContext) {
    if (uid <= 0) throw new CiValidationError("Invalid record.");
    await this.softDelete(USER_RECORDS.education, uid, ctx.userUID);
    return { Message: "Deleted.", Education: await this.repo.education(ctx.userUID) };
  }

  async saveExperience(form: ExperienceDto, ctx: WriteContext) {
    const uid = postInt(form, "ExpUID");
    const employer = String(form.EmployerName ?? "").trim();
    if (!employer) throw new CiValidationError("Employer name is required.");
    await this.repo.saveUserRecord(USER_RECORDS.experience, uid, ctx.userUID, {
      EmployerName: employer.slice(0, 200),
      JobTitle: textOrNull(form.JobTitle, 100),
      StartDate: dateOrNull(form.StartDate),
      EndDate: dateOrNull(form.EndDate),
      JobDescription: textOrNull(form.JobDescription),
    });
    return { Message: uid > 0 ? "Experience updated." : "Experience added.", Experience: await this.repo.experience(ctx.userUID) };
  }

  async deleteExperience(uid: number, ctx: WriteContext) {
    if (uid <= 0) throw new CiValidationError("Invalid record.");
    await this.softDelete(USER_RECORDS.experience, uid, ctx.userUID);
    return { Message: "Deleted.", Experience: await this.repo.experience(ctx.userUID) };
  }

  // ── Expenses & reimbursements ───────────────────────────────────────────

  async getExpenses(orgUID: number, userUID: number) {
    return { Data: await this.repo.expenses(userUID, orgUID) };
  }

  // saveExpense — receipts sent with the form are stored too; a receipt that fails or is over 5 MB is skipped
  async saveExpense(form: ExpenseFormDto, ctx: WriteContext, receipts: Express.Multer.File[]) {
    const { orgUID, userUID } = ctx;
    const type = String(form.ReimbursementType ?? "").trim();
    if (!type) throw new CiValidationError("Reimbursement type is required.");
    const amount = String(form.Amount ?? "").trim();
    if (amount === "" || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      throw new CiValidationError("Please enter a valid amount greater than zero.");
    }
    const expenseDate = dateOrNull(form.ExpenseDate);
    if (!expenseDate) throw new CiValidationError("Expense date is required.");
    if (!REIMBURSEMENT_TYPES.includes(type)) throw new CiValidationError("Invalid reimbursement type.");

    const expenseUID = await this.repo.saveUserRecord(
      USER_RECORDS.expense,
      postInt(form, "ExpenseUID"),
      userUID,
      {
        ReimbursementType: type,
        Category: textOrNull(form.Category, 100),
        Merchant: textOrNull(form.Merchant, 100),
        Amount: phpRound(Number(amount), AMOUNT_DECIMALS),
        ExpenseDate: expenseDate,
        Reference: textOrNull(form.Reference, 200),
        Description: textOrNull(form.Description),
      },
      { OrgUID: orgUID }
    );

    for (const [index, file] of receipts.entries()) {
      await this.profile
        .storeAttachment(ctx, file, `employees/${userUID}/expenses/`, { RefType: "Expense", RefUID: expenseUID, DocType: "Receipt" }, index)
        .catch(() => undefined);
    }
    return { Message: "Expense saved successfully.", ExpenseUID: expenseUID, Data: await this.repo.expenses(userUID, orgUID) };
  }

  async deleteExpense(uid: number, ctx: WriteContext) {
    if (uid <= 0) throw new CiValidationError("Invalid record.");
    await this.softDelete(USER_RECORDS.expense, uid, ctx.userUID);
    return { Message: "Expense deleted.", Data: await this.repo.expenses(ctx.userUID, ctx.orgUID) };
  }

  private async softDelete(record: UserRecord, uid: number, userUID: number, extra: Record<string, unknown> = {}): Promise<void> {
    await this.repo.updateUserRecords(record, userUID, { [record.pk]: uid }, { IsDeleted: 1, IsActive: 0, ...extra, UpdatedBy: userUID });
  }
}
