import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postIntList, postString, postValue } from "../../core/utils/form-values";
import { toInt } from "../../common/utils/php-compat";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { CategoryListDto } from "./dto/product-list.dto";
import { CategoryBulkDeleteDto, CategoryFormDto, CategoryIdDto } from "./dto/product-write.dto";
import { ProductAttachmentService, UploadedFile } from "./product-attachment.service";
import { ProductCacheService } from "./product-cache.service";
import { CATEGORY_LANG, ProductMastersRepository } from "./product-masters.repository";
import { ProductTextService } from "./product-text.service";
import { ProductsRepository } from "./products.repository";

/** Product categories (CI3 Products controller category actions). */
@Injectable()
export class ProductCategoriesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly masters: ProductMastersRepository,
    private readonly products: ProductsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly text: ProductTextService,
    private readonly cache: ProductCacheService,
    private readonly attachments: ProductAttachmentService,
    private readonly audit: AuditLogService
  ) {}

  // getCategoryList — one page; the CI3 JS builds the rows and pagination
  async getPage(orgUID: number, pageNo: number, dto: CategoryListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const page = Math.max(1, pageNo);
    const result = await this.masters.listCategories(orgUID, page, rowLimit, dto.Filter ?? {}, dto.langCode);
    return { Data: result.rows, TotalCount: result.totalCount, PageNo: page, RowLimit: rowLimit, UIDs: result.rows.map((row) => row.CategoryUID) };
  }

  // getAllCategories — CI3 rendered the category filter box (catgfilter view); here its data
  async getAll(orgUID: number, langCode: string) {
    return { Message: "Retrieved Successfully", Categories: await this.masters.findCategories(orgUID, langCode) };
  }

  // getCategoryOptions — { uid, name } options
  async getOptions(orgUID: number, langCode: string) {
    const rows = await this.masters.findCategories(orgUID, langCode);
    return { Options: rows.map((row) => ({ uid: toInt(row.CategoryUID), name: row.Name })) };
  }

  // retrieveCategoryDetails
  async getDetail(orgUID: number, categoryUID: number, langCode: string) {
    if (categoryUID <= 0) throw new CiValidationError("Invalid Category ID");
    const [category] = await this.masters.findCategories(orgUID, langCode, categoryUID);
    if (!category) throw new CiValidationError("Category not found");
    return { Message: "Retrieved Successfully", Data: category };
  }

  // getProductsByCategory
  async getProducts(orgUID: number, categoryUID: number, langCode: string) {
    if (categoryUID <= 0) throw new CiValidationError("Invalid Category.");
    const products = await this.products.findByCategory(orgUID, categoryUID, langCode);
    return { Products: products, Count: products.length };
  }

  // addCategoryDetails / updateCategoryDetails — then Tamil text (background), images, cache and audit
  async save(form: CategoryFormDto, ctx: WriteContext, files: UploadedFile[], isUpdate: boolean) {
    // CI3 categoryValidateForm only checks CategoryUID (its other rules name fields the form does not send)
    const categoryUID = postInt(form, "CategoryUID");
    if (isUpdate && !/^[-+]?\d*\.?\d+$/.test(String(postValue(form, "CategoryUID", "") ?? ""))) {
      throw new CiValidationError(
        String(postValue(form, "CategoryUID", "")) === "" ? "The Category UID field is required." : "The Category UID field must contain only numbers.",
        { Errors: "Please correct the highlighted errors." }
      );
    }
    const before = isUpdate ? (await this.masters.findCategories(ctx.orgUID, "en", categoryUID))[0] ?? null : null;
    const names = await this.text.normalize(postString(form, "CategoryName"), postString(form, "CategoryDescription"));
    const row: Record<string, unknown> = { Name: names.name, OrgUID: ctx.orgUID, Description: names.description, UpdatedBy: ctx.userUID };

    const uid = isUpdate
      ? (await this.masters.updateCategories(ctx.orgUID, [categoryUID], row), categoryUID)
      : await this.db.transaction((trx) => this.masters.insertCategory(trx, { ...row, CategToken: randomUUID(), CreatedBy: ctx.userUID }));

    this.text.scheduleTamil(`category ${uid}`, names.typed, (name, description) =>
      this.masters.saveLangRow(CATEGORY_LANG, uid, "ta", name, description, ctx.userUID)
    );
    await this.attachments.apply(ctx, "Category", uid, postString(form, "CatgAttachDeleteUIDs"), files);
    await this.cache.refreshCategories(ctx.orgUID, uid);
    await this.audit.log(ctx, {
      action: isUpdate ? "UPDATE_PRODUCT_CATEGORY" : "CREATE_PRODUCT_CATEGORY",
      entityType: "ProductCategory",
      entityUID: uid,
      entityRef: String(names.name ?? ""),
      summary: `${isUpdate ? "Updated" : "Created"} product category ${names.name ?? ""}`,
      module: "Products",
      category: "MASTER",
      oldValues: before ?? {},
      newValues: row,
    });
    return isUpdate ? { Message: "Updated Successfully" } : { Message: "Created Successfully", InsertId: uid, CategoryName: names.name };
  }

  // deleteCategoryDetails — refused while products use it
  async delete(dto: CategoryIdDto, ctx: WriteContext) {
    const categoryUID = postInt(dto, "CategoryUID");
    if (categoryUID <= 0) throw new CiValidationError("Invalid Category ID");
    if (await this.products.hasProductsInCategories(ctx.orgUID, [categoryUID])) {
      throw new CiValidationError("This category is linked to one or more products and cannot be deleted.");
    }
    const [before] = await this.masters.findCategories(ctx.orgUID, "en", categoryUID);
    await this.masters.updateCategories(ctx.orgUID, [categoryUID], { IsDeleted: 1, UpdatedBy: ctx.userUID });
    await this.cache.removeCategories(ctx.orgUID, [categoryUID]);
    await this.audit.log(ctx, {
      action: "DELETE_PRODUCT_CATEGORY",
      entityType: "ProductCategory",
      entityUID: categoryUID,
      entityRef: before?.Name ?? "",
      summary: `Deleted product category #${categoryUID}`,
      module: "Products",
      category: "MASTER",
      oldValues: before ?? {},
    });
    return { Message: "Deleted Successfully" };
  }

  // deleteBulkCategory
  async deleteBulk(dto: CategoryBulkDeleteDto, ctx: WriteContext) {
    if (postValue(dto, "CategoryUIDs") === null) throw new CiValidationError("No categories selected for deletion");
    const categoryUIDs = postIntList(dto, "CategoryUIDs");
    if (categoryUIDs.length === 0) throw new CiValidationError("Invalid category IDs provided");
    if (await this.products.hasProductsInCategories(ctx.orgUID, categoryUIDs)) {
      throw new CiValidationError("One or more categories are linked to Product(s). Cannot delete.");
    }
    await this.masters.updateCategories(ctx.orgUID, categoryUIDs, { IsDeleted: 1, UpdatedBy: ctx.userUID });
    await this.cache.removeCategories(ctx.orgUID, categoryUIDs);
    await this.audit.log(ctx, {
      action: "BULK_DELETE_PRODUCT_CATEGORIES",
      entityType: "ProductCategory",
      entityUID: 0,
      entityRef: categoryUIDs.join(","),
      details: { count: categoryUIDs.length },
      summary: `Bulk deleted ${categoryUIDs.length} product categor${categoryUIDs.length === 1 ? "y" : "ies"}`,
      module: "Products",
      category: "MASTER",
      oldValues: { deletedUIDs: categoryUIDs },
    });
    return { Message: "Deleted Successfully" };
  }

  // syncCategoriesCache
  async syncCache(orgUID: number) {
    const count = await this.cache.syncCategories(orgUID);
    if (count === 0) throw new CiValidationError("No active categories found.");
    return { Message: `${count} categorie(s) synced to cache.`, Count: count };
  }
}
