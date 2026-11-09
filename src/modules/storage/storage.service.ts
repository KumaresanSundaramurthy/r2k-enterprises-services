import { Injectable } from "@nestjs/common";
import { uniqueUploadName } from "../../common/utils/upload-names";
import { BackgroundTaskService } from "../../core/background/background-task.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postIntList, postValue } from "../../core/utils/form-values";
import { CiFormValidator, validationErrorsText } from "../../core/validation/ci-form-validator";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { TranslationService, TypedText } from "../../libraries/translation/translation.service";
import { StorageFilter, StorageRepository } from "./storage.repository";

type Form = Record<string, unknown>;

// CI3 Formvalidation_model::storageValidateForm. Short Name is required and limited to 25: the column is NOT NULL,
// unique and 25 characters long, so CI3's optional / 50-character short name was refused by the database.
const storageValidator = new CiFormValidator({
  StorageUID: { label: "Category UID", required: true, numeric: true },
  Name: { label: "Name", required: true, minLength: 3, maxLength: 100 },
  ShortName: { label: "Short Name", required: true, maxLength: 25 },
  StorageTypeUID: { label: "Storage Type", required: true, numeric: true },
});

// StorageTbl's unique indexes (on Name and on ShortName, across every org and deleted rows too)
const DUPLICATE_MESSAGES: Record<string, string> = {
  storagetbl_unique: "A storage with this Name already exists.",
  storagetbl_unique_1: "A storage with this Short Name already exists.",
};

interface StorageTexts {
  name: string | null;
  shortName: string | null;
  description: string | null;
  typed: { name: TypedText; shortName: TypedText; description: TypedText };
}

/** Storage page of CI3 (Storage controller): the org's storage locations (racks, shelves, ...) products are kept in. */
@Injectable()
export class StorageService {
  constructor(
    private readonly repo: StorageRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly translation: TranslationService,
    private readonly background: BackgroundTaskService,
    private readonly fileUpload: FileUploadService,
    private readonly audit: AuditLogService
  ) {}

  // index — whether storage is enabled (CI3 sent the user to the dashboard when not), the storage types and page 1
  async getPageData(orgUID: number, langCode: string) {
    const settings = await this.orgSettings.get(orgUID);
    const [types, page] = await Promise.all([this.repo.types(), this.getPage(orgUID, 1, settings.RowLimit, {}, langCode)]);
    return { EnableStorage: settings.EnableStorage === 1, StorageTypeInfo: types, ...page };
  }

  // getStorageList — one page; the CI3 JS builds the rows and pagination from Data / TotalCount
  async getPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: StorageFilter, langCode: string) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const [rows, total] = await Promise.all([this.repo.list(orgUID, filter, langCode, limit, (page - 1) * limit), this.repo.count(orgUID, filter)]);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit };
  }

  // getAllStorage — every storage of the org (CI3 rendered the product page's storage filter; it listed every org's)
  async getAll(orgUID: number, langCode: string) {
    await this.orgSettings.get(orgUID);
    return { Message: "Retrieved Successfully", Storage: await this.repo.list(orgUID, {}, langCode) };
  }

  // addStorageData / updateStorageData — Tamil input stored in English, the Tamil row written in the background
  async save(ctx: WriteContext, form: Form, image: Express.Multer.File | undefined, isUpdate: boolean) {
    // Name and type are required even when not posted (CI3 only checked fields that were posted)
    const errors = storageValidator.validate({ Name: "", ShortName: "", StorageTypeUID: "", ...form });
    if (Object.keys(errors).length > 0) throw new CiValidationError(validationErrorsText(errors));

    const storageUID = isUpdate ? postInt(form, "StorageUID") : 0;
    // CI3 updated by StorageUID alone, so any org's storage could be changed (and moved into the caller's org)
    if (isUpdate && (await this.repo.existing(ctx.orgUID, [storageUID])).length === 0) throw new CiValidationError("Storage not found.");

    const texts = await this.texts(form);
    const row: Form = {
      Name: texts.name,
      ShortName: texts.shortName,
      StorageTypeUID: postInt(form, "StorageTypeUID"),
      Description: texts.description,
      UpdatedBy: ctx.userUID,
    };
    if (isUpdate && postValue(form, "ImageRemoved")) row.Image = null;

    let uid: number;
    try {
      uid = isUpdate
        ? (await this.repo.update(ctx.orgUID, [storageUID], row), storageUID)
        : await this.repo.insert({ ...row, OrgUID: ctx.orgUID, CreatedBy: ctx.userUID });
    } catch (err) {
      const index = /for key '(?:[^.']*\.)?([^']+)'/.exec((err as { sqlMessage?: string }).sqlMessage ?? "")?.[1] ?? "";
      if ((err as { code?: string }).code === "ER_DUP_ENTRY" && DUPLICATE_MESSAGES[index]) throw new CiValidationError(DUPLICATE_MESSAGES[index]);
      throw err;
    }

    this.background.run(`Tamil text for storage ${uid}`, async () => {
      const [name, shortName, description] = await Promise.all([
        this.translation.typedToTamil(texts.typed.name),
        this.translation.typedToTamil(texts.typed.shortName),
        this.translation.typedToTamil(texts.typed.description),
      ]);
      await this.repo.saveLangRow(uid, "ta", name, shortName, description, ctx.userUID);
    });

    // fileUploadService — products/storage/images/<name>_<uniqid>.<ext>, stored as "/<path>"
    if (image) {
      const upload = await this.fileUpload.upload(`products/storage/images/${uniqueUploadName(image.originalname)}`, image.buffer, image.mimetype);
      await this.repo.update(ctx.orgUID, [uid], { Image: "/" + upload.Path });
    }

    await this.audit.log(ctx, {
      action: isUpdate ? "UPDATE_STORAGE" : "CREATE_STORAGE",
      entityType: "Storage",
      entityUID: uid,
      entityRef: String(texts.name ?? ""),
      summary: `${isUpdate ? "Updated" : "Created"} storage ${texts.name ?? ""}`,
      module: "Storage",
      category: "MASTER",
      newValues: row,
    });
    return { Message: isUpdate ? "Updated Successfully" : "Created Successfully", StorageUID: uid, ...(await this.listAfterChange(ctx.orgUID, form)) };
  }

  // deleteStorageDetails / deleteBulkStorage — refused while products are kept in any of them
  async delete(ctx: WriteContext, form: Form, bulk: boolean) {
    const storageUIDs = bulk ? postIntList(form, "StorageUIDs") : [postInt(form, "StorageUID")].filter((uid) => uid > 0);
    if (storageUIDs.length === 0) throw new CiValidationError("Storage Information is Missing to Delete");
    // Only the org's own storages (CI3 deleted by StorageUID alone)
    const found = await this.repo.existing(ctx.orgUID, storageUIDs);
    if (found.length !== storageUIDs.length) throw new CiValidationError("Storage not found.");
    if (await this.repo.hasProducts(ctx.orgUID, storageUIDs)) throw new CiValidationError("Storage is linked to Product.");

    await this.repo.update(ctx.orgUID, storageUIDs, { IsDeleted: 1, UpdatedBy: ctx.userUID });
    await this.audit.log(ctx, {
      action: bulk ? "BULK_DELETE_STORAGE" : "DELETE_STORAGE",
      entityType: "Storage",
      entityUID: bulk ? 0 : storageUIDs[0],
      entityRef: storageUIDs.join(","),
      summary: bulk ? `Bulk deleted ${storageUIDs.length} storage(s)` : `Deleted storage #${storageUIDs[0]}`,
      module: "Storage",
      category: "MASTER",
      oldValues: { deletedUIDs: storageUIDs },
    });
    return { Message: "Deleted Successfully", ...(await this.listAfterChange(ctx.orgUID, form)) };
  }

  // Name / ShortName / Description: Tamil input translated to English for StorageTbl, what was typed kept for the Tamil row
  private async texts(form: Form): Promise<StorageTexts> {
    const field = (key: string) => String(postValue(form, key) ?? "").trim();
    const [name, shortName, description] = await Promise.all([
      this.translation.normalize(field("Name")),
      this.translation.normalize(field("ShortName")),
      this.translation.normalize(field("Description")),
    ]);
    return {
      name: name.english,
      shortName: shortName.english,
      description: description.english,
      typed: { name: name.typed, shortName: shortName.typed, description: description.typed },
    };
  }

  // renderStorageList after a change — the posted page (RowLimit / PageNo / Filter) refreshed
  private async listAfterChange(orgUID: number, form: Form) {
    const page = await this.getPage(orgUID, postInt(form, "PageNo") || 1, postInt(form, "RowLimit") || undefined, StorageService.filterOf(form.Filter), String(form.langCode || "en"));
    return { Data: page.Data, TotalCount: page.TotalCount, PageNo: page.PageNo, RowLimit: page.RowLimit };
  }

  // Filter posted as JSON (or an object)
  private static filterOf(value: unknown): StorageFilter {
    let raw: unknown = value;
    if (typeof value === "string") {
      try {
        raw = JSON.parse(value);
      } catch {
        raw = {};
      }
    }
    if (!raw || typeof raw !== "object") return {};
    const filter = raw as Record<string, unknown>;
    const types = Array.isArray(filter.StorageType) ? filter.StorageType : filter.StorageType !== undefined ? [filter.StorageType] : [];
    return {
      SearchAllData: typeof filter.SearchAllData === "string" ? filter.SearchAllData : undefined,
      StorageType: types.map((type) => parseInt(String(type), 10)).filter((type) => !Number.isNaN(type)),
    };
  }
}
