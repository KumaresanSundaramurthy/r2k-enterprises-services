import { Injectable, Logger } from "@nestjs/common";
import { timestampedUploadName } from "../../common/utils/upload-names";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { DocumentKind } from "./transaction-kinds";

const ATTACHMENTS = "Transaction.TransAttachmentsTbl";

// One uploaded file as multer hands it over (memory storage)
export type UploadedFile = Pick<Express.Multer.File, "originalname" | "mimetype" | "size" | "buffer">;

/**
 * Files attached to a transaction (CI3 MY_Controller::_saveAttachments / _softDeleteAttachments without a
 * SourceType), stored under {orgToken}/{module folder}/{TransUID}/.
 */
@Injectable()
export class TransactionAttachmentsService {
  private readonly logger = new Logger(TransactionAttachmentsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly fileUpload: FileUploadService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // _saveAttachments — after the document's existing files; a file that fails to upload is skipped
  async save(ctx: WriteContext, kind: DocumentKind, transUID: number, files: UploadedFile[]): Promise<void> {
    if (files.length === 0) return;
    const token = String((await this.orgSettings.get(ctx.orgUID)).OrgToken ?? "").replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || `org-${ctx.orgUID}`;
    const max = await this.db.read(ATTACHMENTS).max("SortOrder as MaxOrder").where({ TransUID: transUID, OrgUID: ctx.orgUID }).first();
    const sortOffset = Number(max?.MaxOrder ?? 0) + 1;
    for (const [index, file] of files.entries()) {
      if (!file.originalname) continue;
      let path: string;
      try {
        const result = await this.fileUpload.upload(`${token}/${kind.attachFolder}/${transUID}/${timestampedUploadName(file.originalname, index)}`, file.buffer, file.mimetype);
        path = "/" + result.Path.replace(/^\/+/, "");
      } catch (err) {
        this.logger.warn(`Upload of ${file.originalname} failed: ${(err as Error).message}`);
        continue;
      }
      await this.db.write(ATTACHMENTS).insert({
        OrgUID: ctx.orgUID,
        TransUID: transUID,
        ModuleUID: kind.moduleUID,
        FileName: file.originalname,
        FilePath: path,
        FileType: file.mimetype,
        FileSize: file.size,
        SortOrder: sortOffset + index,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: ctx.userUID,
      });
    }
  }

  // _softDeleteAttachments — RemovedAttachIDs as a JSON array or a comma-separated list, of this document only
  async remove(ctx: WriteContext, transUID: number, removed: unknown): Promise<void> {
    const text = String(removed ?? "").trim();
    if (!text) return;
    let ids: unknown[] = text.split(",");
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        ids = Array.isArray(parsed) ? parsed : [];
      } catch {
        ids = [];
      }
    }
    const uids = ids.map((id) => parseInt(String(id), 10)).filter((id) => id > 0);
    if (uids.length === 0) return;
    await this.db.write(ATTACHMENTS).whereIn("AttachUID", uids).where({ OrgUID: ctx.orgUID, TransUID: transUID }).update({ IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
  }
}
