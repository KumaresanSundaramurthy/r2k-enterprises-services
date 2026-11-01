import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postIntList, postString, postValue } from "../../core/utils/form-values";
import { CiFormValidator } from "../../core/validation/ci-form-validator";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { CategoryListDto } from "./dto/product-list.dto";
import { BrandBulkDeleteDto, BrandFormDto, BrandIdDto } from "./dto/product-write.dto";
import { ProductAttachmentService, UploadedFile } from "./product-attachment.service";
import { ProductCacheService } from "./product-cache.service";
import { BRAND_LANG, ProductMastersRepository } from "./product-masters.repository";
import { ProductTextService } from "./product-text.service";

// CI3 Formvalidation_model::brandValidateForm
const brandValidator = new CiFormValidator({
  BrandUID: { label: "Brand UID", required: true, numeric: true },
  BrandName: { label: "Brand Name", required: true, minLength: 2, maxLength: 150 },
  BrandCode: { label: "Brand Code", maxLength: 50 },
  Description: { label: "Description", maxLength: 500 },
});

/** Product brands (CI3 Products controller brand actions). */
@Injectable()
export class ProductBrandsService {
  constructor(
    private readonly masters: ProductMastersRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly text: ProductTextService,
    private readonly cache: ProductCacheService,
    private readonly attachments: ProductAttachmentService,
    private readonly audit: AuditLogService
  ) {}

  // getBrandList
  async getPage(orgUID: number, pageNo: number, dto: CategoryListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const page = Math.max(1, pageNo);
    const result = await this.masters.listBrands(orgUID, page, rowLimit, dto.Filter ?? {}, dto.langCode);
    return { Data: result.rows, TotalCount: result.totalCount, PageNo: page, RowLimit: rowLimit };
  }

  // retrieveBrandDetails — the brand and its images
  async getDetail(orgUID: number, brandUID: number) {
    if (brandUID <= 0) throw new CiValidationError("Invalid brand.");
    const [brand] = await this.masters.findBrands(orgUID, brandUID);
    if (!brand) throw new CiValidationError("Brand not found.");
    return { Data: brand, Attachments: await this.masters.findAttachments(orgUID, "Brand", brandUID) };
  }

  // addBrandDetails / updateBrandDetails — unique name per organisation; then Tamil text, images (and cache) and audit
  async save(form: BrandFormDto, ctx: WriteContext, files: UploadedFile[], isUpdate: boolean) {
    const brandUID = isUpdate ? postInt(form, "BrandUID") : 0;
    if (isUpdate && brandUID <= 0) throw new CiValidationError("Invalid brand.");
    const text = (key: string) => String(postValue(form, key, "") ?? "");
    const errors = Object.values(
      brandValidator.validate({ BrandUID: brandUID, BrandName: text("BrandName"), BrandCode: text("BrandCode"), Description: text("Description") })
    );
    if (errors.length > 0) throw new CiValidationError(errors.join("\n"));
    if (await this.masters.isDuplicateBrandName(ctx.orgUID, text("BrandName"), brandUID)) throw new CiValidationError("A brand with this name already exists.");

    const [before] = isUpdate ? await this.masters.findBrands(ctx.orgUID, brandUID) : [];
    const names = await this.text.normalize(text("BrandName"), text("Description"));
    const row: Record<string, unknown> = {
      OrgUID: ctx.orgUID,
      BrandName: names.name ?? "",
      BrandCode: text("BrandCode").trim() || null,
      Description: names.description,
      UpdatedBy: ctx.userUID,
    };
    const uid = isUpdate
      ? (await this.masters.updateBrands(ctx.orgUID, [brandUID], row), brandUID)
      : await this.masters.insertBrand({ ...row, BrandToken: randomUUID(), CreatedBy: ctx.userUID });

    this.text.scheduleTamil(`brand ${uid}`, names.typed, (name, description) => this.masters.saveLangRow(BRAND_LANG, uid, "ta", name, description, ctx.userUID));
    // Also refreshes the brand's cache entry (its images are part of it)
    await this.attachments.apply(ctx, "Brand", uid, postString(form, "BrandAttachDeleteUIDs"), files);
    await this.audit.log(ctx, {
      action: isUpdate ? "UPDATE_BRAND" : "ADD_BRAND",
      entityType: "Brand",
      entityUID: uid,
      entityRef: String(row.BrandName),
      details: isUpdate ? undefined : { BrandName: row.BrandName, BrandCode: row.BrandCode },
      summary: `${isUpdate ? "Updated" : "Created"} brand "${row.BrandName}"`,
      module: "Products",
      category: "MASTER",
      oldValues: before ?? {},
      newValues: row,
    });
    return isUpdate ? { Message: "Brand updated successfully." } : { Message: "Brand created successfully.", InsertId: uid };
  }

  // deleteBrandDetails — refused while variants or transaction lines use it
  async delete(dto: BrandIdDto, ctx: WriteContext) {
    const brandUID = postInt(dto, "BrandUID");
    if (brandUID <= 0) throw new CiValidationError("Invalid brand.");
    if ((await this.masters.brandsInUse(ctx.orgUID, [brandUID])).length > 0) {
      throw new CiValidationError("This brand is linked to one or more product variants and cannot be deleted.");
    }
    await this.masters.updateBrands(ctx.orgUID, [brandUID], { IsDeleted: 1, UpdatedBy: ctx.userUID });
    await this.cache.removeBrands(ctx.orgUID, [brandUID]);
    await this.audit.log(ctx, {
      action: "DELETE_BRAND",
      entityType: "Brand",
      entityUID: brandUID,
      details: { brandUID },
      summary: `Deleted brand #${brandUID}`,
      module: "Products",
      category: "MASTER",
      oldValues: { brandUID },
    });
    return { Message: "Brand deleted successfully." };
  }

  // deleteBulkBrand
  async deleteBulk(dto: BrandBulkDeleteDto, ctx: WriteContext) {
    if (postValue(dto, "BrandUIDs") === null) throw new CiValidationError("No brands selected for deletion.");
    const brandUIDs = postIntList(dto, "BrandUIDs");
    if (brandUIDs.length === 0) throw new CiValidationError("Invalid brand IDs provided.");
    const inUse = await this.masters.brandsInUse(ctx.orgUID, brandUIDs);
    if (inUse.length > 0) {
      throw new CiValidationError(`${inUse.length} of the selected brand${inUse.length > 1 ? "s are" : " is"} linked to product variants and cannot be deleted.`);
    }
    await this.masters.updateBrands(ctx.orgUID, brandUIDs, { IsDeleted: 1, UpdatedBy: ctx.userUID });
    await this.cache.removeBrands(ctx.orgUID, brandUIDs);
    await this.audit.log(ctx, {
      action: "BULK_DELETE_BRANDS",
      entityType: "Brand",
      entityUID: 0,
      entityRef: brandUIDs.join(","),
      details: { count: brandUIDs.length },
      summary: `Bulk deleted ${brandUIDs.length} brand${brandUIDs.length > 1 ? "s" : ""}`,
      module: "Products",
      category: "MASTER",
      oldValues: { deletedUIDs: brandUIDs },
    });
    return { Message: "Deleted Successfully." };
  }

  // syncBrandsCache
  async syncCache(orgUID: number) {
    const count = await this.cache.syncBrands(orgUID);
    if (count === 0) throw new CiValidationError("No active brands found.");
    return { Message: `${count} brand(s) synced to cache.`, Count: count };
  }
}
