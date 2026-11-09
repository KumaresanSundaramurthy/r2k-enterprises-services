import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const STORAGE = "Products.StorageTbl";
const STORAGE_LANG = "Products.StorageTbl_Lang";

// List filter the CI3 storage page posts (Filter[...])
export interface StorageFilter {
  SearchAllData?: string;
  StorageType?: number[];
}

/** Storage locations of the org (CI3 Storage_model) and the global storage types. */
@Injectable()
export class StorageRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getStorageDetails — the org's live storages by StorageUID, in the UI language, with the image's CDN Url
  async list(orgUID: number, filter: StorageFilter, langCode: string, limit = 0, offset = 0, storageUIDs: number[] = []): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.filtered(orgUID, filter)
      .select(
        "Storage.StorageUID",
        "Storage.OrgUID",
        this.langColumn(useLang, "SL.Name", "Storage.Name", "Name"),
        this.langColumn(useLang, "SL.ShortName", "Storage.ShortName", "ShortName"),
        this.langColumn(useLang, "SL.Description", "Storage.Description", "Description"),
        "Storage.StorageTypeUID",
        "StorageType.Name as StorageTypeName",
        "Storage.Image",
        "Storage.CreatedOn",
        "Storage.UpdatedOn"
      )
      .leftJoin("Global.StorageTypeTbl as StorageType", "StorageType.StorageTypeUID", "Storage.StorageTypeUID")
      .orderBy("Storage.StorageUID", "asc");
    if (useLang) query.leftJoin(`${STORAGE_LANG} as SL`, (on) => on.on("SL.StorageUID", "Storage.StorageUID").andOnVal("SL.LangCode", "=", langCode));
    if (storageUIDs.length > 0) query.whereIn("Storage.StorageUID", storageUIDs);
    if (limit > 0) query.limit(limit).offset(offset);
    const rows: Row[] = await query;
    return rows.map((row) => ({ ...row, Url: row.Image ? resolveCdnUrl(String(row.Image)) : null }));
  }

  // getTotalStorageCount
  async count(orgUID: number, filter: StorageFilter): Promise<number> {
    const row = await this.filtered(orgUID, filter).count("* as cnt").first();
    return Number(row?.cnt ?? 0);
  }

  // The org's live storages among `storageUIDs` (for update / delete)
  async existing(orgUID: number, storageUIDs: number[]): Promise<number[]> {
    if (storageUIDs.length === 0) return [];
    const rows: Row[] = await this.read(STORAGE).select("StorageUID").where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 }).whereIn("StorageUID", storageUIDs);
    return rows.map((row) => Number(row.StorageUID));
  }

  // getStorageTypeData — active storage types in their display order (global, not per org)
  types(): Promise<Row[]> {
    return this.read("Global.StorageTypeTbl as StorageType")
      .select("StorageType.StorageTypeUID", "StorageType.Name", "StorageType.UpdatedOn")
      .where({ "StorageType.IsDeleted": 0, "StorageType.IsActive": 1 })
      .orderBy("StorageType.Sorting", "asc");
  }

  // getProductsDetails(['Products.StorageUID' => ...]) — live products still placed in any of these storages
  async hasProducts(orgUID: number, storageUIDs: number[]): Promise<boolean> {
    return !!(await this.read("Products.ProductTbl").select("ProductUID").where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 }).whereIn("StorageUID", storageUIDs).first());
  }

  async insert(row: Row): Promise<number> {
    const [id] = await this.db.write(STORAGE).insert(row);
    return Number(id);
  }

  // Only the org's live storages are changed
  update(orgUID: number, storageUIDs: number[], data: Row): Promise<number> {
    return this.db.write(STORAGE).where({ OrgUID: orgUID, IsDeleted: 0 }).whereIn("StorageUID", storageUIDs).update(data);
  }

  // saveStorageLangRow — insert or replace the translated texts of one language
  async saveLangRow(storageUID: number, langCode: string, name: string | null, shortName: string | null, description: string | null, userUID: number): Promise<void> {
    await this.db
      .write(STORAGE_LANG)
      .insert({ StorageUID: storageUID, LangCode: langCode, Name: name, ShortName: shortName, Description: description, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict()
      .merge(["Name", "ShortName", "Description", "UpdatedBy"]);
  }

  // buildStorageFilter / buildStorageDirectQuery — search text and storage types
  private filtered(orgUID: number, filter: StorageFilter): Knex.QueryBuilder {
    const query = this.read(`${STORAGE} as Storage`).where({ "Storage.OrgUID": orgUID, "Storage.IsDeleted": 0, "Storage.IsActive": 1 });
    const search = String(filter.SearchAllData ?? "").trim();
    if (search) this.whereAnyLike(query, ["Storage.Name", "Storage.ShortName", "Storage.Description"], search);
    if (filter.StorageType?.length) query.whereIn("Storage.StorageTypeUID", filter.StorageType);
    return query;
  }
}
