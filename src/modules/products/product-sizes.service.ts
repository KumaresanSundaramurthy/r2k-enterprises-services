import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postIntList, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { SizeListDto } from "./dto/product-list.dto";
import { QuickSizeDto, SizeBulkDeleteDto, SizeFormDto, SizeIdDto } from "./dto/product-write.dto";
import { ProductCacheService } from "./product-cache.service";
import { ProductMastersRepository, SIZE_LANG } from "./product-masters.repository";
import { ProductTextService } from "./product-text.service";

const MEASURES = ["Length", "Width", "Height", "Depth", "Diameter", "Thickness", "Weight"];

// A measurement field: empty → NULL, otherwise its number
const measure = (form: object, key: string) => {
  const value = (form as Record<string, unknown>)[key];
  return value === undefined || value === null || value === "" ? null : Number(value) || 0;
};

/** Product sizes (CI3 Products controller size actions). */
@Injectable()
export class ProductSizesService {
  constructor(
    private readonly masters: ProductMastersRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly text: ProductTextService,
    private readonly cache: ProductCacheService,
    private readonly audit: AuditLogService
  ) {}

  // getSizes — active sizes for the variant picker of the product form
  async getAll(orgUID: number) {
    return { Data: await this.masters.findSizes(orgUID) };
  }

  // getSizeList
  async getPage(orgUID: number, pageNo: number, dto: SizeListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const page = Math.max(1, pageNo);
    const result = await this.masters.listSizes(orgUID, page, rowLimit, dto.Filter ?? {}, dto.langCode);
    return { Data: result.rows, TotalCount: result.totalCount, PageNo: page, RowLimit: rowLimit };
  }

  // addSize — inline "Add Size" of the product form (an existing size of that name is reused)
  async quickAdd(dto: QuickSizeDto, ctx: WriteContext) {
    const name = (postString(dto, "SizeName") ?? "").trim();
    if (name === "") throw new CiValidationError("Size name is required");
    if (name.length > 100) throw new CiValidationError("Size name is too long (max 100 characters)");
    const sizeUID = await this.masters.upsertSizeByName(ctx.orgUID, name);
    if (sizeUID <= 0) throw new CiValidationError("Failed to create size");
    return { Message: "Size added", SizeUID: sizeUID };
  }

  // addSizeDetails / updateSizeDetails — unique name per organisation; then audit, cache and Tamil text
  async save(form: SizeFormDto, ctx: WriteContext, isUpdate: boolean) {
    const sizeUID = isUpdate ? postInt(form, "SizeUID") : 0;
    if (isUpdate && sizeUID <= 0) throw new CiValidationError("Invalid size.");
    const names = await this.text.normalize(postString(form, "SizeName"), postString(form, "Description"));
    const name = names.name ?? "";
    if (name === "") throw new CiValidationError("Size name is required.");
    if (name.length > 100) throw new CiValidationError("Size name is too long (max 100 characters).");
    if (await this.masters.isDuplicateSizeName(ctx.orgUID, name, sizeUID)) throw new CiValidationError("A size with this name already exists.");

    const row: Record<string, unknown> = {
      Name: name,
      SizeCode: String(postValue(form, "SizeCode", "") ?? "").trim() || null,
      ...Object.fromEntries(MEASURES.map((key) => [key, measure(form, key)])),
      DimensionUOM: String(postValue(form, "DimensionUOM", "") ?? "").trim() || null,
      WeightUOM: String(postValue(form, "WeightUOM", "") ?? "").trim() || null,
      Description: names.description,
      UpdatedBy: ctx.userUID,
    };
    const uid = isUpdate
      ? (await this.masters.updateSizes(ctx.orgUID, [sizeUID], row), sizeUID)
      : await this.masters.insertSize({ ...row, OrgUID: ctx.orgUID, IsActive: 1, CreatedBy: ctx.userUID });

    await this.audit.log(ctx, {
      action: isUpdate ? "UPDATE_SIZE" : "ADD_SIZE",
      entityType: "Size",
      entityUID: uid,
      entityRef: name,
      details: isUpdate ? undefined : { SizeName: name },
      summary: `${isUpdate ? "Updated" : "Created"} size "${name}"`,
      module: "Products",
      category: "MASTER",
      newValues: row,
    });
    await this.cache.refreshSize(ctx.orgUID, uid);
    this.text.scheduleTamil(`size ${uid}`, names.typed, (tamilName, description) => this.masters.saveLangRow(SIZE_LANG, uid, "ta", tamilName, description, ctx.userUID));
    return isUpdate ? { Message: "Size updated successfully." } : { Message: "Size created successfully.", InsertId: uid };
  }

  // deleteSizeDetails — deactivates the size; refused while variants use it
  async delete(dto: SizeIdDto, ctx: WriteContext) {
    const sizeUID = postInt(dto, "SizeUID");
    if (sizeUID <= 0) throw new CiValidationError("Invalid size.");
    if ((await this.masters.sizesInUse(ctx.orgUID, [sizeUID])).length > 0) {
      throw new CiValidationError("This size is linked to one or more product variants and cannot be deleted.");
    }
    await this.masters.updateSizes(ctx.orgUID, [sizeUID], { IsActive: 0, UpdatedBy: ctx.userUID });
    await this.audit.log(ctx, {
      action: "DELETE_SIZE",
      entityType: "Size",
      entityUID: sizeUID,
      details: { sizeUID },
      summary: `Deleted size #${sizeUID}`,
      module: "Products",
      category: "MASTER",
      oldValues: { sizeUID },
    });
    await this.cache.removeSizes(ctx.orgUID, [sizeUID]);
    return { Message: "Size deleted successfully." };
  }

  // deleteBulkSize
  async deleteBulk(dto: SizeBulkDeleteDto, ctx: WriteContext) {
    if (postValue(dto, "SizeUIDs") === null) throw new CiValidationError("No sizes selected for deletion.");
    const sizeUIDs = postIntList(dto, "SizeUIDs");
    if (sizeUIDs.length === 0) throw new CiValidationError("Invalid size IDs provided.");
    const inUse = await this.masters.sizesInUse(ctx.orgUID, sizeUIDs);
    if (inUse.length > 0) {
      throw new CiValidationError(`${inUse.length} of the selected size${inUse.length > 1 ? "s are" : " is"} linked to product variants and cannot be deleted.`);
    }
    await this.masters.updateSizes(ctx.orgUID, sizeUIDs, { IsActive: 0, UpdatedBy: ctx.userUID });
    await this.audit.log(ctx, {
      action: "BULK_DELETE_SIZES",
      entityType: "Size",
      entityUID: 0,
      entityRef: sizeUIDs.join(","),
      details: { count: sizeUIDs.length },
      summary: `Bulk deleted ${sizeUIDs.length} size${sizeUIDs.length > 1 ? "s" : ""}`,
      module: "Products",
      category: "MASTER",
      oldValues: { deletedUIDs: sizeUIDs },
    });
    await this.cache.removeSizes(ctx.orgUID, sizeUIDs);
    return { Message: "Deleted successfully." };
  }

  // syncSizesCache
  async syncCache(orgUID: number) {
    const count = await this.cache.syncSizes(orgUID);
    if (count === 0) throw new CiValidationError("No active sizes found.");
    return { Message: `${count} size(s) synced to cache.`, Count: count };
  }
}
