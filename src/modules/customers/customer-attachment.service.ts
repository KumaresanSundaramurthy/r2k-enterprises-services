import { Injectable, Logger } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { CustomerCacheService } from "./customer-cache.service";
import { CustomersRepository } from "./customers.repository";

const MAX_FILES = 3;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif"];

// One uploaded file as multer hands it over (memory storage)
export type UploadedFile = Pick<Express.Multer.File, "originalname" | "mimetype" | "size" | "buffer">;

/**
 * Customer images (CI3 getCustomerAttachments / saveCustomerAttachments / deleteCustomerAttachment and
 * _handleCustomerAttachments). Up to 3 images, 3 MB in total; the first one is the customer's Image.
 */
@Injectable()
export class CustomerAttachmentService {
  private readonly logger = new Logger(CustomerAttachmentService.name);

  constructor(
    private readonly customers: CustomersRepository,
    private readonly fileUpload: FileUploadService,
    private readonly orgSettings: OrgSettingsService,
    private readonly cache: CustomerCacheService,
    private readonly audit: AuditLogService
  ) {}

  async list(orgUID: number, customerUID: number) {
    if (customerUID <= 0) throw new CiValidationError("Invalid customer.");
    return { Attachments: await this.customers.findAttachments(orgUID, customerUID) };
  }

  // saveCustomerAttachments — uploads more images for an existing customer
  async save(ctx: WriteContext, customerUID: number, files: UploadedFile[]) {
    if (customerUID <= 0) throw new CiValidationError("Invalid customer.");
    await this.requireCustomer(ctx.orgUID, customerUID);
    const saved = await this.apply(ctx, customerUID, "", files);
    await this.refreshCache(ctx.orgUID, customerUID);
    return { Message: `${saved.length} image(s) saved.`, Saved: saved };
  }

  // deleteCustomerAttachment
  async deleteOne(ctx: WriteContext, attachUID: number, customerUID: number) {
    if (attachUID <= 0) throw new CiValidationError("Invalid attachment.");
    if (customerUID > 0) await this.requireCustomer(ctx.orgUID, customerUID);
    await this.customers.softDeleteAttachments(ctx.orgUID, Math.max(customerUID, 0), [attachUID], ctx.userUID);
    if (customerUID > 0) {
      await this.syncPrimaryImage(ctx, customerUID);
      await this.refreshCache(ctx.orgUID, customerUID);
    }
    await this.audit.log(ctx, {
      action: "DELETE_CUSTOMER_ATTACHMENT",
      entityType: "Customer",
      entityUID: customerUID,
      details: { attachUID },
      summary: `Deleted attachment #${attachUID} for customer #${customerUID}`,
      module: "Customers",
      category: "MASTER",
      oldValues: { attachUID },
    });
    return { Message: "Attachment deleted." };
  }

  /**
   * _handleCustomerAttachments — deletes the listed attachments, uploads the new images that fit
   * (allowed type, free slots, total size) and updates the customer's Image. Files that fail to
   * upload are skipped, like CI3. Used by create / update (which refresh the cache themselves) and save.
   */
  async apply(ctx: WriteContext, customerUID: number, deleteUIDs: string, files: UploadedFile[]) {
    const toDelete = String(deleteUIDs || "")
      .split(",")
      .map((uid) => parseInt(uid, 10))
      .filter((uid) => uid > 0);
    // Only this customer's attachments (CI3 matched the organisation only)
    await this.customers.softDeleteAttachments(ctx.orgUID, customerUID, toDelete, ctx.userUID);

    const saved: { FileName: string; FilePath: string }[] = [];
    if (files.length > 0) {
      const stats = await this.customers.attachmentStats(ctx.orgUID, customerUID);
      const slots = MAX_FILES - stats.count;
      const timestamp = Math.floor(Date.now() / 1000);
      let used = stats.totalSize;
      for (let i = 0; i < files.length && saved.length < slots; i++) {
        const file = files[i];
        if (!file.originalname || !ALLOWED_TYPES.includes(file.mimetype)) continue;
        if (used + file.size > MAX_TOTAL_BYTES) break;
        used += file.size;
        const safeName = `${timestamp}_${i}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        let path: string;
        try {
          path = "/" + (await this.fileUpload.upload(`customers/attachments/${customerUID}/${safeName}`, file.buffer, file.mimetype)).Path;
        } catch {
          continue;
        }
        await this.customers.insertAttachment({
          OrgUID: ctx.orgUID,
          CustomerUID: customerUID,
          FileName: file.originalname,
          FilePath: path,
          FileSize: file.size,
          SortOrder: stats.maxSort + 1 + saved.length,
          IsDeleted: 0,
          IsActive: 1,
          CreatedBy: ctx.userUID,
          UpdatedBy: ctx.userUID,
        });
        saved.push({ FileName: file.originalname, FilePath: path });
      }
    }
    await this.syncPrimaryImage(ctx, customerUID);
    return saved;
  }

  // _syncCustomerPrimaryImage — the first remaining attachment becomes CustomerTbl.Image (null when none)
  private async syncPrimaryImage(ctx: WriteContext, customerUID: number): Promise<void> {
    try {
      const primary = await this.customers.findPrimaryImage(ctx.orgUID, customerUID);
      await this.customers.updateCustomer(customerUID, { Image: primary, UpdatedBy: ctx.userUID });
    } catch (err) {
      this.logger.error(`Primary image sync for customer ${customerUID} failed: ${(err as Error).message}`);
    }
  }

  private async requireCustomer(orgUID: number, customerUID: number): Promise<void> {
    if (!(await this.customers.findDebitCreditRaw(orgUID, customerUID))) throw new CiValidationError("Customer not found.");
  }

  private async refreshCache(orgUID: number, customerUID: number): Promise<void> {
    const org = await this.orgSettings.get(orgUID);
    await this.cache.refresh(orgUID, org.OrgToken, customerUID);
  }
}
