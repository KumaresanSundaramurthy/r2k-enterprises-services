import { Injectable } from "@nestjs/common";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { uniqueUploadName } from "../../common/utils/upload-names";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { SignatureFormDto } from "./dto/profile.dto";
import { ProfileSessionService } from "./profile-session.service";
import { ProfileRepository, Row, USER_RECORDS } from "./profile.repository";

const SIGNATURES = USER_RECORDS.signature;

// The user's signatures for printed documents (CI3 Profile signature functions). Every change updates the session list.
@Injectable()
export class ProfileSignatureService {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly db: DatabaseService,
    private readonly fileUpload: FileUploadService,
    private readonly session: ProfileSessionService
  ) {}

  // getSignaturesJson — the compact list the transaction forms use
  async getJson(orgUID: number, userUID: number) {
    return { Data: ProfileSessionService.signatureList(await this.repo.signatures(userUID, orgUID)) };
  }

  // getSignatureList — every column of the signatures (CI3 renders them as HTML), with the image as a CDN URL
  async getList(orgUID: number, userUID: number) {
    const rows = await this.repo.signatures(userUID, orgUID);
    return { Data: rows.map((sig) => ({ ...sig, ImagePath: sig.ImagePath ? resolveCdnUrl(String(sig.ImagePath)) : sig.ImagePath })) };
  }

  // saveSignature — the user's first signature becomes the default
  async create(form: SignatureFormDto, ctx: WriteContext, image: Express.Multer.File | undefined, sessionKey: string | undefined) {
    const { orgUID, userUID } = ctx;
    const type = ProfileSignatureService.type(form);
    const row: Row = {
      UserUID: userUID,
      OrgUID: orgUID,
      Label: ProfileSignatureService.label(form),
      SignatureType: type,
      IsDefault: 0,
      CreatedBy: userUID,
      UpdatedBy: userUID,
    };
    if (type === "Draw") {
      const drawData = String(form.DrawData ?? "");
      if (!drawData.startsWith("data:image/")) throw new CiValidationError("Signature drawing is empty. Please draw your signature first.");
      row.DrawData = drawData;
      row.MimeType = "image/png";
    } else {
      if (!image) throw new CiValidationError("No image file uploaded or upload error occurred.");
      Object.assign(row, await this.uploadImage(image));
    }

    const signatureUID = await this.repo.insertUserRecord(SIGNATURES, row);
    const list = await this.repo.signatures(userUID, orgUID);
    if (list.length === 1) {
      await this.repo.updateUserRecords(SIGNATURES, userUID, { SignatureUID: signatureUID }, { IsDefault: 1 });
      list[0].IsDefault = 1;
    }
    await this.session.patchSignatures(sessionKey, list);
    return { Message: "Signature saved successfully" };
  }

  // updateSignature — a new drawing or image replaces the old one; the label can change alone
  async update(form: SignatureFormDto, ctx: WriteContext, image: Express.Multer.File | undefined, sessionKey: string | undefined) {
    const { orgUID, userUID } = ctx;
    const signatureUID = postInt(form, "SignatureUID");
    if (!signatureUID) throw new CiValidationError("Invalid signature");
    const type = ProfileSignatureService.type(form);
    if (!(await this.repo.signatureExists(signatureUID, userUID))) throw new CiValidationError("Signature not found");

    const data: Row = { Label: ProfileSignatureService.label(form), SignatureType: type, UpdatedBy: userUID };
    const drawData = String(form.DrawData ?? "");
    if (type === "Draw" && drawData.startsWith("data:image/")) {
      Object.assign(data, { DrawData: drawData, ImagePath: null, MimeType: "image/png", FileSize: null });
    }
    if (type === "Upload" && image) {
      Object.assign(data, await this.uploadImage(image), { DrawData: null });
    }
    await this.repo.updateUserRecords(SIGNATURES, userUID, { SignatureUID: signatureUID, IsDeleted: 0 }, data);

    await this.session.patchSignatures(sessionKey, await this.repo.signatures(userUID, orgUID));
    return { Message: "Signature updated successfully" };
  }

  // deleteSignature
  async delete(signatureUID: number, ctx: WriteContext, sessionKey: string | undefined) {
    if (!signatureUID) throw new CiValidationError("Invalid signature");
    await this.repo.updateUserRecords(SIGNATURES, ctx.userUID, { SignatureUID: signatureUID }, { IsDeleted: 1, IsActive: 0, IsDefault: 0, UpdatedBy: ctx.userUID });
    await this.session.patchSignatures(sessionKey, await this.repo.signatures(ctx.userUID, ctx.orgUID));
    return { Message: "Signature deleted" };
  }

  // setDefaultSignature — one default per user
  async setDefault(signatureUID: number, ctx: WriteContext, sessionKey: string | undefined) {
    const { orgUID, userUID } = ctx;
    if (!signatureUID) throw new CiValidationError("Invalid signature");
    await this.db.write.transaction(async (trx) => {
      await this.repo.updateUserRecords(SIGNATURES, userUID, { OrgUID: orgUID, IsDeleted: 0 }, { IsDefault: 0, UpdatedBy: userUID }, trx);
      await this.repo.updateUserRecords(SIGNATURES, userUID, { SignatureUID: signatureUID }, { IsDefault: 1, UpdatedBy: userUID }, trx);
    });
    await this.session.patchSignatures(sessionKey, await this.repo.signatures(userUID, orgUID));
    return { Message: "Default signature updated" };
  }

  // fileUploadService into signatures/ — the columns that describe the stored image
  private async uploadImage(image: Express.Multer.File): Promise<Row> {
    const upload = await this.fileUpload.upload(`signatures/${uniqueUploadName(image.originalname)}`, image.buffer, image.mimetype);
    return { ImagePath: "/" + upload.Path, MimeType: image.mimetype || "image/png", FileSize: image.size };
  }

  private static type(form: SignatureFormDto): "Upload" | "Draw" {
    const type = String(form.SignatureType ?? "").trim();
    if (type !== "Upload" && type !== "Draw") throw new CiValidationError("Invalid signature type");
    return type;
  }

  private static label(form: SignatureFormDto): string {
    return (String(form.Label ?? "").trim() || "My Signature").slice(0, 100);
  }
}
