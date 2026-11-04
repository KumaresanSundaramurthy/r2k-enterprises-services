import { Injectable, Logger } from "@nestjs/common";
import { timestampedUploadName } from "../../common/utils/upload-names";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { EntryKind } from "./entry-kind";
import { EntryRepository } from "./entry.repository";

// One uploaded file as multer hands it over (memory storage)
export type UploadedFile = Pick<Express.Multer.File, "originalname" | "mimetype" | "size" | "buffer">;

/**
 * Files attached to an expense or income record (CI3 MY_Controller::_saveAttachments / _softDeleteAttachments
 * with a SourceType), stored under {orgToken}/{expenses|indirectincome}/{uid}/.
 */
@Injectable()
export class EntryAttachmentsService {
  private readonly logger = new Logger(EntryAttachmentsService.name);

  constructor(
    private readonly repo: EntryRepository,
    private readonly fileUpload: FileUploadService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // _saveAttachments — new files go after the record's existing ones; a file that fails to upload is skipped
  async save(ctx: WriteContext, kind: EntryKind, sourceUID: number, files: UploadedFile[]): Promise<void> {
    if (files.length === 0) return;
    const folder = `${await this.orgFolder(ctx.orgUID)}/${kind.attachFolder}/${sourceUID}`;
    const sortOffset = (await this.repo.maxAttachmentSort(ctx.orgUID, kind.sourceType, sourceUID)) + 1;
    for (const [index, file] of files.entries()) {
      const path = await this.store(folder, file, index);
      if (!path) continue;
      await this.repo.insertAttachment({
        OrgUID: ctx.orgUID,
        SourceUID: sourceUID,
        SourceType: kind.sourceType,
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

  // _softDeleteAttachments — RemovedAttachIDs as a JSON array or a comma-separated list
  async remove(ctx: WriteContext, kind: EntryKind, removed: unknown): Promise<void> {
    const text = String(removed ?? "").trim();
    if (!text) return;
    let ids: unknown[];
    if (text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text);
        ids = Array.isArray(parsed) ? parsed : [];
      } catch {
        ids = [];
      }
    } else {
      ids = text.split(",");
    }
    const uids = ids.map((id) => parseInt(String(id), 10)).filter((id) => id > 0);
    await this.repo.softDeleteAttachments(ctx.orgUID, kind.sourceType, uids);
  }

  // Storage folder of the organisation: its OrgToken (letters, digits, "_" and "-"), or org-{OrgUID}
  async orgFolder(orgUID: number): Promise<string> {
    const token = String((await this.orgSettings.get(orgUID)).OrgToken ?? "")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .toLowerCase();
    return token || `org-${orgUID}`;
  }

  // Uploads one file as {time}_{index}_{safe name}; the stored path (with a leading "/"), or null when it failed
  async store(folder: string, file: UploadedFile, index: number): Promise<string | null> {
    if (!file.originalname) return null;
    try {
      const result = await this.fileUpload.upload(`${folder}/${timestampedUploadName(file.originalname, index)}`, file.buffer, file.mimetype);
      return "/" + result.Path.replace(/^\/+/, "");
    } catch (err) {
      this.logger.warn(`Upload of ${file.originalname} failed: ${(err as Error).message}`);
      return null;
    }
  }
}
