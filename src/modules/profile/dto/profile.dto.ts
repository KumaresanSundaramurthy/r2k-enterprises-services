import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";

// The profile always belongs to userId (CI3 JwtData->User->UserUID); every DTO here extends OrgUserContextDto.

/** updateProfileDetails — name, mobile, photo and (optionally) password. */
export class ProfileDetailsDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "Posted by the CI3 form; the user updated is always userId" }) @Allow() userUid?: string | number;
  @ApiPropertyOptional({ description: "First name (CI3 field name)" }) @Allow() fistName?: string;
  @ApiPropertyOptional() @Allow() lastName?: string;
  @ApiPropertyOptional({ example: "+91" }) @Allow() CountryCode?: string;
  @ApiPropertyOptional({ example: "IN" }) @Allow() CountryISO2?: string;
  @ApiPropertyOptional() @Allow() MobileNumber?: string;
  @ApiPropertyOptional({ description: "1 = remove the photo" }) @Allow() ImageRemoved?: string | number;
  @ApiPropertyOptional({ description: "1 = change the password with oldPassword / newPassword / confirmPassword" }) @Allow() IsPasswordUpdate?: string | number;
  @ApiPropertyOptional() @Allow() oldPassword?: string;
  @ApiPropertyOptional() @Allow() newPassword?: string;
  @ApiPropertyOptional() @Allow() confirmPassword?: string;
  @ApiPropertyOptional({ type: "string", format: "binary", description: "New profile photo" }) UploadImage?: unknown;
}

export class ProfileWorkInfoDto extends OrgUserContextDto {
  @ApiPropertyOptional() @Allow() DepartmentUID?: string | number;
  @ApiPropertyOptional() @Allow() DesignationUID?: string | number;
  @ApiPropertyOptional({ enum: ["Active", "Resigned", "Terminated", "OnLeave"] }) @Allow() EmployeeStatus?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateOfJoining?: string;
  @ApiPropertyOptional({ enum: ["Permanent", "Contract", "Part-time", "Intern", "Consultant"] }) @Allow() EmploymentType?: string;
  @ApiPropertyOptional() @Allow() WorkEmail?: string;
  @ApiPropertyOptional() @Allow() WorkPhone?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() ProbationEndDate?: string;
  @ApiPropertyOptional() @Allow() NoticePeriodDays?: string | number;
  @ApiPropertyOptional() @Allow() ReportingManagerUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() LastWorkingDate?: string;
  @ApiPropertyOptional() @Allow() ExitReason?: string;
}

/** saveProfileAddress — Curr* (Current) and Perm* (Permanent) addresses. */
export class ProfileAddressDto extends OrgUserContextDto {
  @ApiPropertyOptional() @Allow() CurrAddressLine1?: string;
  @ApiPropertyOptional() @Allow() CurrAddressLine2?: string;
  @ApiPropertyOptional() @Allow() CurrCity?: string;
  @ApiPropertyOptional() @Allow() CurrState?: string;
  @ApiPropertyOptional() @Allow() CurrPinCode?: string;
  @ApiPropertyOptional({ example: "India" }) @Allow() CurrCountry?: string;
  @ApiPropertyOptional() @Allow() PermAddressLine1?: string;
  @ApiPropertyOptional() @Allow() PermAddressLine2?: string;
  @ApiPropertyOptional() @Allow() PermCity?: string;
  @ApiPropertyOptional() @Allow() PermState?: string;
  @ApiPropertyOptional() @Allow() PermPinCode?: string;
  @ApiPropertyOptional({ example: "India" }) @Allow() PermCountry?: string;
}

export class ProfileAttachmentDto extends OrgUserContextDto {
  @ApiPropertyOptional({ example: "General" }) @Allow() DocType?: string;
  @ApiProperty({ type: "string", format: "binary", description: "Max 5 MB" }) AttachFile?: unknown;
}

export class AttachmentIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() AttachUID?: string | number;
}

export class ExpenseIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() ExpenseUID?: string | number;
}

export class ExpenseAttachmentDto extends ExpenseIdDto {
  @ApiProperty({ type: "string", format: "binary", description: "Max 5 MB" }) AttachFile?: unknown;
}

export class ExpenseAttachmentIdDto extends ExpenseIdDto {
  @ApiProperty({ type: Number }) @Allow() AttachUID?: string | number;
}

/** saveSignature / updateSignature — an uploaded image (SignatureImage) or a drawing (DrawData). */
export class SignatureFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "updateSignature only" }) @Allow() SignatureUID?: string | number;
  @ApiProperty({ enum: ["Upload", "Draw"] }) @Allow() SignatureType?: string;
  @ApiPropertyOptional({ example: "My Signature" }) @Allow() Label?: string;
  @ApiPropertyOptional({ description: "Draw: data:image/png;base64,…" }) @Allow() DrawData?: string;
  @ApiPropertyOptional({ type: "string", format: "binary", description: "Upload: the image" }) SignatureImage?: unknown;
}

export class SignatureIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() SignatureUID?: string | number;
}

export class EmergencyContactDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = new contact" }) @Allow() EmgContactUID?: string | number;
  @ApiPropertyOptional({ description: "Required" }) @Allow() Name?: string;
  @ApiPropertyOptional({ description: "Required" }) @Allow() Relationship?: string;
  @ApiPropertyOptional({ description: "Required" }) @Allow() PhoneNumber?: string;
  @ApiPropertyOptional() @Allow() EmailAddress?: string;
  @ApiPropertyOptional() @Allow() AddressLine1?: string;
  @ApiPropertyOptional() @Allow() AddressLine2?: string;
  @ApiPropertyOptional() @Allow() City?: string;
  @ApiPropertyOptional() @Allow() State?: string;
  @ApiPropertyOptional() @Allow() Country?: string;
  @ApiPropertyOptional({ description: "1 = primary contact (clears it on the others)" }) @Allow() IsPrimary?: string | number;
}

export class EmergencyContactIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() EmgContactUID?: string | number;
}

export class BankDetailsDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() BankDetailUID?: string | number;
  @ApiPropertyOptional() @Allow() BankName?: string;
  @ApiPropertyOptional() @Allow() BranchName?: string;
  @ApiPropertyOptional() @Allow() IFSCCode?: string;
  @ApiPropertyOptional() @Allow() AccountNumber?: string;
  @ApiPropertyOptional() @Allow() AccountType?: string;
  @ApiPropertyOptional() @Allow() AccountHolder?: string;
  @ApiPropertyOptional() @Allow() UpiId?: string;
  @ApiPropertyOptional() @Allow() UpiNumber?: string;
}

export class EducationDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() EduUID?: string | number;
  @ApiPropertyOptional({ description: "Required" }) @Allow() Institution?: string;
  @ApiPropertyOptional() @Allow() Degree?: string;
  @ApiPropertyOptional() @Allow() FieldOfStudy?: string;
  @ApiPropertyOptional() @Allow() CGPA?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() DateOfCompletion?: string;
}

export class EducationIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() EduUID?: string | number;
}

export class ExperienceDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() ExpUID?: string | number;
  @ApiPropertyOptional({ description: "Required" }) @Allow() EmployerName?: string;
  @ApiPropertyOptional() @Allow() JobTitle?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() StartDate?: string;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() EndDate?: string;
  @ApiPropertyOptional() @Allow() JobDescription?: string;
}

export class ExperienceIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() ExpUID?: string | number;
}

export class ExpenseFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() ExpenseUID?: string | number;
  @ApiPropertyOptional({ enum: ["Travel", "Medical", "Food & Entertainment", "Accommodation", "Communication", "Office Supplies", "Others"] })
  @Allow()
  ReimbursementType?: string;
  @ApiPropertyOptional() @Allow() Category?: string;
  @ApiPropertyOptional() @Allow() Merchant?: string;
  @ApiPropertyOptional({ description: "Greater than zero" }) @Allow() Amount?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD" }) @Allow() ExpenseDate?: string;
  @ApiPropertyOptional() @Allow() Reference?: string;
  @ApiPropertyOptional() @Allow() Description?: string;
  @ApiPropertyOptional({ type: "array", items: { type: "string", format: "binary" }, description: "Receipts[] (max 5 MB each)" }) Receipts?: unknown;
}
