import { Injectable, Logger } from "@nestjs/common";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { ProductCacheService } from "./product-cache.service";
import { AttachmentEntity, ProductMastersRepository } from "./product-masters.repository";

const ENTITIES: AttachmentEntity[] = ["Product", "Category", "Brand"];
const ALLOWED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/gif"];
const FOLDERS: Record<AttachmentEntity, string> = { Product: "products", Category: "categories", Brand: "brands" };

// Products take 5 images / 5 MB, categories and brands 3 / 3 MB
const limitsOf = (entity: AttachmentEntity) => (entity === "Product" ? { files: 5, bytes: 5 * 1024 * 1024 } : { files: 3, bytes: 3 * 1024 * 1024 });

export type UploadedFile = Pick<Express.Multer.File, "originalname" | "mimetype" | "size" | "buffer">;

/**
 * Images of products, categories and brands in Products.EntityAttachmentsTbl (CI3 _handleAttachments,
 * getAttachments, saveAttachments, deleteAttachment, _syncPrimaryImage).
 */
@Injectable()
export class ProductAttachmentService {
  private readonly logger = new Logger(ProductAttachmentService.name);

  constructor(
    private readonly masters: ProductMastersRepository,
    private readonly fileUpload: FileUploadService,
    private readonly cache: ProductCacheService
  ) {}

  // getAttachments
  async list(orgUID: number, entityType: string | undefined, entityUID: number) {
    const entity = this.requireEntity(entityType, entityUID);
    return { Attachments: await this.masters.findAttachments(orgUID, entity, entityUID) };
  }

  /**
   * _handleAttachments — deletes the listed attachments, uploads the new images that fit (allowed type, free
   * slots, total size) and refreshes what shows the first image. Files that fail to upload are skipped (logged).
   */
  async apply(ctx: WriteContext, entity: AttachmentEntity, entityUID: number, deleteUIDs: string | null | undefined, files: UploadedFile[]): Promise<void> {
    const toDelete = String(deleteUIDs ?? "")
      .split(",")
      .map((uid) => parseInt(uid, 10))
      .filter((uid) => uid > 0);
    await this.masters.softDeleteAttachments(ctx.orgUID, toDelete, ctx.userUID, { type: entity, uid: entityUID });
    if (files.length > 0) await this.upload(ctx, entity, entityUID, files);
    await this.afterChange(ctx.orgUID, entity, entityUID);
  }

  // saveAttachments — uploads images for an existing product, category or brand
  async save(ctx: WriteContext, entityType: string | undefined, entityUID: number, files: UploadedFile[]) {
    const entity = this.requireEntity(entityType, entityUID);
    if (files.length === 0) return { Message: "No files uploaded." };
    const saved = await this.upload(ctx, entity, entityUID, files);
    await this.afterChange(ctx.orgUID, entity, entityUID);
    return { Message: `${saved.length} image(s) saved.`, Saved: saved };
  }

  // deleteAttachment
  async deleteOne(ctx: WriteContext, attachUID: number, entityType: string | undefined, entityUID: number) {
    if (attachUID <= 0) throw new CiValidationError("Invalid attachment.");
    await this.masters.softDeleteAttachments(ctx.orgUID, [attachUID], ctx.userUID);
    if ((entityType === "Product" || entityType === "Category") && entityUID > 0) await this.afterChange(ctx.orgUID, entityType, entityUID);
    return { Message: "Attachment deleted." };
  }

  private async upload(ctx: WriteContext, entity: AttachmentEntity, entityUID: number, files: UploadedFile[]) {
    const limits = limitsOf(entity);
    const stats = await this.masters.attachmentStats(ctx.orgUID, entity, entityUID);
    const timestamp = Math.floor(Date.now() / 1000);
    let used = stats.totalSize;
    const saved: { AttachUID: number; FileName: string; FilePath: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file.originalname || !ALLOWED_TYPES.includes(file.mimetype)) continue;
      if (stats.count + saved.length >= limits.files) break;
      if (used + file.size > limits.bytes) break;
      used += file.size;
      const safeName = `${timestamp}_${i}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      let path: string;
      try {
        path = "/" + (await this.fileUpload.upload(`${FOLDERS[entity]}/attachments/${entityUID}/${safeName}`, file.buffer, file.mimetype)).Path;
      } catch (err) {
        this.logger.error(`Upload of ${file.originalname} for ${entity} ${entityUID} failed: ${(err as Error).message}`);
        continue;
      }
      const attachUID = await this.masters.insertAttachment({
        OrgUID: ctx.orgUID,
        EntityType: entity,
        EntityUID: entityUID,
        FileName: file.originalname,
        FilePath: path,
        FileSize: file.size,
        SortOrder: stats.maxSort + 1 + saved.length,
        IsDeleted: 0,
        IsActive: 1,
        CreatedBy: ctx.userUID,
        UpdatedBy: ctx.userUID,
      });
      saved.push({ AttachUID: attachUID, FileName: file.originalname, FilePath: path });
    }
    return saved;
  }

  // _syncPrimaryImage — ProductTbl / CategoryTbl have no Image column (CI3's update of it failed), so only the
  // product cache entry is refreshed; brands keep their images in the brand cache entry
  private async afterChange(orgUID: number, entity: AttachmentEntity, entityUID: number) {
    if (entity === "Product") await this.cache.refreshProduct(orgUID, entityUID);
    if (entity === "Brand") await this.cache.refreshBrand(orgUID, entityUID);
  }

  private requireEntity(entityType: string | undefined, entityUID: number): AttachmentEntity {
    if (!ENTITIES.includes(entityType as AttachmentEntity)) throw new CiValidationError("Invalid entity type.");
    if (entityUID <= 0) throw new CiValidationError("Invalid entity ID.");
    return entityType as AttachmentEntity;
  }
}
