import { Injectable, Logger } from "@nestjs/common";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { timestampedUploadName } from "../../common/utils/upload-names";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { UserAccessService } from "../../libraries/user-access/user-access.service";
import { DriveRepository } from "./drive.repository";

// 100 MB per user (CI3 Drive::QUOTA_BYTES)
export const QUOTA_BYTES = 104857600;

// Who is acting and whose drive is open (a Super Admin may open another user's drive)
export interface DriveContext {
  orgUID: number;
  actorUID: number;
  viewUID: number;
}

// Characters a file system rejects become "_"
const safeName = (name: string) => name.replace(/[/\\:*?"<>|]/g, "_");

export interface DownloadTarget {
  url: string;
  name: string;
  mimeType: string;
  size: number | null;
}

// Settings → My Drive (CI3 Drive controller): personal file storage with folders.
@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    private readonly repo: DriveRepository,
    private readonly access: UserAccessService,
    private readonly orgSettings: OrgSettingsService,
    private readonly fileUpload: FileUploadService
  ) {}

  // _resolveViewUser — non-admins always get their own drive
  async context(orgUID: number, actorUID: number, requestedViewUID: number): Promise<DriveContext> {
    const isAdmin = await this.access.isSuperAdmin(orgUID, actorUID);
    return { orgUID, actorUID, viewUID: isAdmin && requestedViewUID > 0 ? requestedViewUID : actorUID };
  }

  // index — whether the caller is a Super Admin, whose drives they can open, the quota and the CDN base
  async getPageData(orgUID: number, actorUID: number) {
    const isAdmin = await this.access.isSuperAdmin(orgUID, actorUID);
    return {
      IsAdmin: isAdmin,
      CurrentUserUID: actorUID,
      QuotaBytes: QUOTA_BYTES,
      OrgUsers: isAdmin ? await this.repo.loginUsers(orgUID) : [],
      CdnUrl: resolveCdnUrl("/").replace(/\/+$/, ""),
    };
  }

  // getItems — the folder's contents, breadcrumb and usage
  async getItems(ctx: DriveContext, parentUID: number) {
    const [items, breadcrumb, used] = await Promise.all([
      this.repo.items(ctx.orgUID, ctx.viewUID, parentUID),
      parentUID > 0 ? this.repo.path(ctx.orgUID, parentUID) : Promise.resolve([]),
      this.repo.usage(ctx.orgUID, ctx.viewUID),
    ]);
    return {
      Items: items.map((item) => ({
        uid: Number(item.DriveItemUID),
        type: item.ItemType,
        name: item.ItemName,
        size: item.FileSize === null ? null : Number(item.FileSize),
        mime: item.MimeType,
        path: item.FilePath,
        url: item.FilePath ? resolveCdnUrl(String(item.FilePath)) : null,
        createdOn: item.CreatedOn,
      })),
      Breadcrumb: breadcrumb,
      UsedBytes: used,
      QuotaBytes: QUOTA_BYTES,
    };
  }

  // getUsage
  async getUsage(ctx: DriveContext) {
    return { UsedBytes: await this.repo.usage(ctx.orgUID, ctx.viewUID), QuotaBytes: QUOTA_BYTES };
  }

  // createFolder
  async createFolder(ctx: DriveContext, parentUID: number, folderName: string) {
    const raw = folderName.trim();
    if (!raw || [...raw].length > 255) throw new CiValidationError("Folder name is required (max 255 characters).");
    const name = safeName(raw);
    if (await this.repo.nameTaken(ctx.orgUID, ctx.viewUID, parentUID, name)) throw new CiValidationError("A folder or file with that name already exists here.");
    const uid = await this.repo.insert({
      OrgUID: ctx.orgUID,
      UserUID: ctx.viewUID,
      ParentUID: parentUID,
      ItemType: "Folder",
      ItemName: name,
      FilePath: null,
      FileSize: null,
      MimeType: null,
      CreatedBy: ctx.actorUID,
      UpdatedBy: ctx.actorUID,
    });
    return { Message: "Folder created.", DriveItemUID: uid };
  }

  // uploadFile — files are stored at drive/{OrgToken}/{user}/…; a file over the quota or that fails is listed in Errors
  async upload(ctx: DriveContext, parentUID: number, files: Express.Multer.File[]) {
    if (files.length === 0) throw new CiValidationError("No files received.");
    const orgToken = (await this.orgSettings.get(ctx.orgUID)).OrgToken || String(ctx.orgUID);
    let used = await this.repo.usage(ctx.orgUID, ctx.viewUID);
    let added = 0;
    const errors: string[] = [];

    for (const [index, file] of files.entries()) {
      const name = file.originalname;
      if (used + file.size > QUOTA_BYTES) {
        errors.push(`${name}: Storage quota exceeded (100 MB limit).`);
        continue;
      }
      let path: string;
      try {
        path = "/" + (await this.fileUpload.uploadAt(`drive/${orgToken}/${ctx.viewUID}/${timestampedUploadName(name, index)}`, file.buffer, file.mimetype)).Path;
      } catch (err) {
        this.logger.error(`Drive upload of ${name} failed: ${(err as Error).message}`);
        errors.push(`${name}: Upload failed.`);
        continue;
      }
      await this.repo.insert({
        OrgUID: ctx.orgUID,
        UserUID: ctx.viewUID,
        ParentUID: parentUID,
        ItemType: "File",
        ItemName: name,
        FilePath: path,
        FileSize: file.size,
        MimeType: file.mimetype || "application/octet-stream",
        CreatedBy: ctx.actorUID,
        UpdatedBy: ctx.actorUID,
      });
      used += file.size;
      added++;
    }
    return { Added: added, Errors: errors, UsedBytes: await this.repo.usage(ctx.orgUID, ctx.viewUID) };
  }

  // moveItem
  async move(ctx: DriveContext, itemUID: number, newParentUID: number) {
    if (!itemUID) throw new CiValidationError("Invalid item.");
    if (itemUID === newParentUID) throw new CiValidationError("Cannot move a folder into itself.");
    const item = await this.ownItem(ctx, itemUID);
    if (await this.repo.nameTaken(ctx.orgUID, ctx.viewUID, newParentUID, String(item.ItemName), itemUID)) {
      throw new CiValidationError("An item with that name already exists in the destination.");
    }
    await this.repo.update(ctx.orgUID, ctx.viewUID, itemUID, { ParentUID: newParentUID, UpdatedBy: ctx.actorUID });
    return { Message: "Moved successfully." };
  }

  // renameItem
  async rename(ctx: DriveContext, itemUID: number, newName: string) {
    const raw = newName.trim();
    if (!itemUID || !raw || [...raw].length > 255) throw new CiValidationError("Invalid parameters.");
    const name = safeName(raw);
    const item = await this.ownItem(ctx, itemUID);
    if (await this.repo.nameTaken(ctx.orgUID, ctx.viewUID, Number(item.ParentUID), name, itemUID)) {
      throw new CiValidationError("An item with that name already exists here.");
    }
    await this.repo.update(ctx.orgUID, ctx.viewUID, itemUID, { ItemName: name, UpdatedBy: ctx.actorUID });
    return { Message: "Renamed successfully.", NewName: name };
  }

  // deleteItem — a folder takes its contents with it
  async delete(ctx: DriveContext, itemUID: number) {
    if (!itemUID) throw new CiValidationError("Invalid item.");
    const item = await this.ownItem(ctx, itemUID);
    await this.repo.softDelete(ctx.orgUID, ctx.viewUID, itemUID, ctx.actorUID);
    return { Message: item.ItemType === "Folder" ? "Folder deleted." : "File deleted.", UsedBytes: await this.repo.usage(ctx.orgUID, ctx.viewUID) };
  }

  // downloadFile — the caller's own file (any file for a Super Admin); null = not found, false = not allowed
  async downloadTarget(orgUID: number, actorUID: number, itemUID: number): Promise<DownloadTarget | null | false> {
    const item = await this.repo.find(orgUID, itemUID);
    if (!item || item.ItemType !== "File") return null;
    if (Number(item.UserUID) !== actorUID && !(await this.access.isSuperAdmin(orgUID, actorUID))) return false;
    return {
      url: resolveCdnUrl(String(item.FilePath)),
      name: String(item.ItemName),
      mimeType: String(item.MimeType || "application/octet-stream"),
      size: item.FileSize ? Number(item.FileSize) : null,
    };
  }

  private async ownItem(ctx: DriveContext, itemUID: number) {
    const item = await this.repo.find(ctx.orgUID, itemUID);
    if (!item || Number(item.UserUID) !== ctx.viewUID) throw new CiValidationError("Item not found.");
    return item;
  }
}
