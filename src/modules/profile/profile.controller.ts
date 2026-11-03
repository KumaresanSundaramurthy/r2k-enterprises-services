import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptFiles, AcceptForm, FileFields, filesOf } from "../products/product-files";
import { ClaimsRequest, sessionKeyOf } from "../session-sync/session-sync.service";
import {
  AttachmentIdDto,
  BankDetailsDto,
  EducationDto,
  EducationIdDto,
  EmergencyContactDto,
  EmergencyContactIdDto,
  ExpenseAttachmentDto,
  ExpenseAttachmentIdDto,
  ExpenseFormDto,
  ExpenseIdDto,
  ExperienceDto,
  ExperienceIdDto,
  ProfileAddressDto,
  ProfileAttachmentDto,
  ProfileDetailsDto,
  ProfileWorkInfoDto,
  SignatureFormDto,
  SignatureIdDto,
} from "./dto/profile.dto";
import { ProfileRecordsService } from "./profile-records.service";
import { ProfileSignatureService } from "./profile-signature.service";
import { ProfileService } from "./profile.service";


// Settings → Profile page of CI3 (Profile controller): the logged-in user's own details. userId is that user.
@ApiTags("Profile")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/profile")
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get("getProfileDetails")
  @ApiOperation({ summary: "Page data: userInfo, userFullData (with Addresses), userAttachments, DepartmentsList, DesignationsList, OrgUsersList, bankDetails" })
  async getProfileDetails(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.profile.getPageData(dto.orgId, dto.userId));
  }

  @Post("updateProfileDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("UploadImage")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update name, mobile, photo (UploadImage) and optionally the password; refreshes the session" })
  async updateProfileDetails(@Body() dto: ProfileDetailsDto, @UploadedFiles() files: FileFields, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.profile.updateDetails(dto, writeContext(dto, req), filesOf(files, "UploadImage")[0], sessionKeyOf(req)));
  }

  @Post("saveProfileWorkInfo")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save work information (department, designation, status, dates, manager)" })
  async saveProfileWorkInfo(@Body() dto: ProfileWorkInfoDto, @Req() req: Request) {
    return ciSuccess(await this.profile.saveWorkInfo(dto, writeContext(dto, req)));
  }

  @Post("saveProfileAddress")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save the Current (Curr*) and Permanent (Perm*) addresses" })
  async saveProfileAddress(@Body() dto: ProfileAddressDto, @Req() req: Request) {
    return ciSuccess(await this.profile.saveAddresses(dto, writeContext(dto, req)));
  }

  @Post("saveProfileAttachment")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("AttachFile")
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "Upload a document (AttachFile, max 5 MB) (Attachments)" })
  async saveProfileAttachment(@Body() dto: ProfileAttachmentDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.profile.addProfileAttachment(writeContext(dto, req), filesOf(files, "AttachFile")[0], dto.DocType));
  }

  @Post("deleteProfileAttachment")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a document (Attachments)" })
  async deleteProfileAttachment(@Body() dto: AttachmentIdDto, @Req() req: Request) {
    return ciSuccess(await this.profile.deleteProfileAttachment(writeContext(dto, req), postInt(dto, "AttachUID")));
  }

  @Get("getExpenseAttachments")
  @ApiOperation({ summary: "Receipts of an expense (Attachments)" })
  async getExpenseAttachments(@Query() dto: ExpenseIdDto) {
    return ciSuccess(await this.profile.getExpenseAttachments(dto.orgId, dto.userId, postInt(dto, "ExpenseUID")));
  }

  @Post("deleteExpenseAttachment")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a receipt of an expense (Attachments)" })
  async deleteExpenseAttachment(@Body() dto: ExpenseAttachmentIdDto, @Req() req: Request) {
    return ciSuccess(await this.profile.deleteExpenseAttachment(writeContext(dto, req), postInt(dto, "ExpenseUID"), postInt(dto, "AttachUID")));
  }

  // ── CI3 function the JS does not call: migrated, hidden from Swagger ──────────

  @Post("saveExpenseAttachment")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("AttachFile")
  @ApiExcludeEndpoint()
  async saveExpenseAttachment(@Body() dto: ExpenseAttachmentDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.profile.addExpenseAttachment(writeContext(dto, req), postInt(dto, "ExpenseUID"), filesOf(files, "AttachFile")[0]));
  }
}

// Signatures tab of the profile page and the signature picker of the transaction forms
@ApiTags("Profile Signatures")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/profile")
export class ProfileSignaturesController {
  constructor(private readonly signatures: ProfileSignatureService) {}

  @Get("getSignaturesJson")
  @ApiOperation({ summary: "Signatures for the transaction forms (Data: [{ SignatureUID, Label, SignatureType, ImgSrc, IsDefault }])" })
  async getSignaturesJson(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.signatures.getJson(dto.orgId, dto.userId));
  }

  @Get("getSignatureList")
  @ApiOperation({ summary: "Signatures tab (Data: every column, ImagePath as a CDN URL)" })
  async getSignatureList(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.signatures.getList(dto.orgId, dto.userId));
  }

  @Post("saveSignature")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("SignatureImage")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Add a signature: Upload (SignatureImage) or Draw (DrawData); the first one becomes the default" })
  async saveSignature(@Body() dto: SignatureFormDto, @UploadedFiles() files: FileFields, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.signatures.create(dto, writeContext(dto, req), filesOf(files, "SignatureImage")[0], sessionKeyOf(req)));
  }

  @Post("updateSignature")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("SignatureImage")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a signature's label, drawing or image" })
  async updateSignature(@Body() dto: SignatureFormDto, @UploadedFiles() files: FileFields, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.signatures.update(dto, writeContext(dto, req), filesOf(files, "SignatureImage")[0], sessionKeyOf(req)));
  }

  @Post("deleteSignature")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a signature" })
  async deleteSignature(@Body() dto: SignatureIdDto, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.signatures.delete(postInt(dto, "SignatureUID"), writeContext(dto, req), sessionKeyOf(req)));
  }

  @Post("setDefaultSignature")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Make a signature the default" })
  async setDefaultSignature(@Body() dto: SignatureIdDto, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.signatures.setDefault(postInt(dto, "SignatureUID"), writeContext(dto, req), sessionKeyOf(req)));
  }
}

// Emergency contacts, bank details, education & experience and expenses tabs
@ApiTags("Profile Records")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/profile")
export class ProfileRecordsController {
  constructor(private readonly records: ProfileRecordsService) {}

  @Get("getEmergencyContacts")
  @ApiOperation({ summary: "Emergency contacts, primary first (Contacts)" })
  async getEmergencyContacts(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.records.getEmergencyContacts(dto.userId));
  }

  @Post("saveEmergencyContact")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update an emergency contact (Contacts)" })
  async saveEmergencyContact(@Body() dto: EmergencyContactDto, @Req() req: Request) {
    return ciSuccess(await this.records.saveEmergencyContact(dto, writeContext(dto, req)));
  }

  @Post("deleteEmergencyContact")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete an emergency contact (Contacts)" })
  async deleteEmergencyContact(@Body() dto: EmergencyContactIdDto, @Req() req: Request) {
    return ciSuccess(await this.records.deleteEmergencyContact(postInt(dto, "EmgContactUID"), writeContext(dto, req)));
  }

  @Post("setPrimaryContact")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Make an emergency contact the primary one (Contacts)" })
  async setPrimaryContact(@Body() dto: EmergencyContactIdDto, @Req() req: Request) {
    return ciSuccess(await this.records.setPrimaryContact(postInt(dto, "EmgContactUID"), writeContext(dto, req)));
  }

  @Get("getBankDetails")
  @ApiOperation({ summary: "Bank details (Data, or null)" })
  async getBankDetails(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.records.getBankDetails(dto.userId));
  }

  @Post("saveBankDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save bank details (Data)" })
  async saveBankDetails(@Body() dto: BankDetailsDto, @Req() req: Request) {
    return ciSuccess(await this.records.saveBankDetails(dto, writeContext(dto, req)));
  }

  @Get("getEduExp")
  @ApiOperation({ summary: "Education and experience (Education, Experience)" })
  async getEduExp(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.records.getEduExp(dto.userId));
  }

  @Post("saveEducation")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update education (Education)" })
  async saveEducation(@Body() dto: EducationDto, @Req() req: Request) {
    return ciSuccess(await this.records.saveEducation(dto, writeContext(dto, req)));
  }

  @Post("deleteEducation")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete education (Education)" })
  async deleteEducation(@Body() dto: EducationIdDto, @Req() req: Request) {
    return ciSuccess(await this.records.deleteEducation(postInt(dto, "EduUID"), writeContext(dto, req)));
  }

  @Post("saveExperience")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update experience (Experience)" })
  async saveExperience(@Body() dto: ExperienceDto, @Req() req: Request) {
    return ciSuccess(await this.records.saveExperience(dto, writeContext(dto, req)));
  }

  @Post("deleteExperience")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete experience (Experience)" })
  async deleteExperience(@Body() dto: ExperienceIdDto, @Req() req: Request) {
    return ciSuccess(await this.records.deleteExperience(postInt(dto, "ExpUID"), writeContext(dto, req)));
  }

  @Get("getExpenses")
  @ApiOperation({ summary: "Expenses & reimbursements, newest first (Data)" })
  async getExpenses(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.records.getExpenses(dto.orgId, dto.userId));
  }

  @Post("saveExpense")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("Receipts")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Add / update an expense with receipts (Receipts[]) (ExpenseUID, Data)" })
  async saveExpense(@Body() dto: ExpenseFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.records.saveExpense(dto, writeContext(dto, req), filesOf(files, "Receipts")));
  }

  @Post("deleteExpense")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete an expense (Data)" })
  async deleteExpense(@Body() dto: ExpenseIdDto, @Req() req: Request) {
    return ciSuccess(await this.records.deleteExpense(postInt(dto, "ExpenseUID"), writeContext(dto, req)));
  }
}
