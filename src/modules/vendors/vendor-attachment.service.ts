import { Injectable, Logger } from "@nestjs/common";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { VendorCacheService } from "./vendor-cache.service";
import { VendorsRepository } from "./vendors.repository";

const MAX_FILES = 3;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif"];

// One uploaded file as multer hands it over (memory storage)
export type UploadedFile = Pick<Express.Multer.File, "originalname" | "mimetype" | "size" | "buffer">;

/**
 * Vendor images (CI3 getVendorAttachments / deleteVendorAttachment, _handleVendorAttachments and
 * _syncVendorPrimaryImage). Up to 3 images, 3 MB in total; the first one is the vendor's Image.
 */
@Injectable()
export class VendorAttachmentService {
  private readonly logger = new Logger(VendorAttachmentService.name);

  constructor(
    private readonly vendors: VendorsRepository,
    private readonly fileUpload: FileUploadService,
    private readonly cache: VendorCacheService,
    private readonly audit: AuditLogService
  ) {}

  async list(orgUID: number, vendorUID: number) {
    if (vendorUID <= 0) throw new CiValidationError("Invalid vendor.");
    return { Attachments: await this.vendors.findAttachments(orgUID, vendorUID) };
  }

  // deleteVendorAttachment
  async deleteOne(ctx: WriteContext, attachUID: number, vendorUID: number) {
    if (attachUID <= 0) throw new CiValidationError("Invalid attachment.");
    await this.vendors.softDeleteAttachments(ctx.orgUID, Math.max(vendorUID, 0), [attachUID], ctx.userUID);
    if (vendorUID > 0) await this.syncPrimaryImage(ctx, vendorUID);
    await this.audit.log(ctx, {
      action: "DELETE_VENDOR_ATTACHMENT",
      entityType: "Vendor",
      entityUID: vendorUID,
      details: { attachUID },
      summary: `Deleted attachment #${attachUID} for vendor #${vendorUID}`,
      module: "Vendors",
      category: "MASTER",
      oldValues: { attachUID },
    });
    return { Message: "Attachment deleted." };
  }

  /**
   * _handleVendorAttachments — deletes the listed attachments of this vendor, uploads the new images that fit
   * (allowed type, free slots, total size) and updates the vendor's Image. Files that fail to upload are
   * skipped (and logged), like CI3.
   */
  async apply(ctx: WriteContext, vendorUID: number, deleteUIDs: string, files: UploadedFile[]): Promise<void> {
    const toDelete = String(deleteUIDs || "")
      .split(",")
      .map((uid) => parseInt(uid, 10))
      .filter((uid) => uid > 0);
    await this.vendors.softDeleteAttachments(ctx.orgUID, vendorUID, toDelete, ctx.userUID);

    if (files.length > 0) {
      const stats = await this.vendors.attachmentStats(ctx.orgUID, vendorUID);
      const slots = MAX_FILES - stats.count;
      const timestamp = Math.floor(Date.now() / 1000);
      let used = stats.totalSize;
      let saved = 0;
      for (let i = 0; i < files.length && saved < slots; i++) {
        const file = files[i];
        if (!file.originalname || !ALLOWED_TYPES.includes(file.mimetype)) continue;
        if (used + file.size > MAX_TOTAL_BYTES) break;
        used += file.size;
        const safeName = `${timestamp}_${i}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        let path: string;
        try {
          path = "/" + (await this.fileUpload.upload(`vendors/attachments/${vendorUID}/${safeName}`, file.buffer, file.mimetype)).Path;
        } catch (err) {
          this.logger.error(`Upload of ${file.originalname} for vendor ${vendorUID} failed: ${(err as Error).message}`);
          continue;
        }
        await this.vendors.insertAttachment({
          OrgUID: ctx.orgUID,
          VendorUID: vendorUID,
          FileName: file.originalname,
          FilePath: path,
          FileSize: file.size,
          SortOrder: stats.maxSort + 1 + saved,
          IsDeleted: 0,
          IsActive: 1,
          CreatedBy: ctx.userUID,
          UpdatedBy: ctx.userUID,
        });
        saved++;
      }
    }
    await this.syncPrimaryImage(ctx, vendorUID);
  }

  // _syncVendorPrimaryImage — the first remaining attachment becomes VendorTbl.Image (null when none); refreshes the cache
  private async syncPrimaryImage(ctx: WriteContext, vendorUID: number): Promise<void> {
    try {
      const primary = await this.vendors.findPrimaryImage(ctx.orgUID, vendorUID);
      await this.vendors.updateVendor(ctx.orgUID, vendorUID, { Image: primary, UpdatedBy: ctx.userUID });
      await this.cache.refresh(ctx.orgUID, vendorUID);
    } catch (err) {
      this.logger.error(`Primary image sync for vendor ${vendorUID} failed: ${(err as Error).message}`);
    }
  }
}
