import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postJsonArray, postString, postValue } from "../../core/utils/form-values";
import { toInt } from "../../common/utils/php-compat";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { PriceListFilterDto, PriceListListDto } from "./dto/product-list.dto";
import { PriceListBulkDeleteDto, PriceListDeleteDto, PriceListFormDto } from "./dto/product-write.dto";
import { ProductCacheService } from "./product-cache.service";
import { PriceListsRepository } from "./price-lists.repository";
import { ProductTextService } from "./product-text.service";

const ASSIGNED_TO = ["All", "Groups", "Customers"];
const SCOPES = ["All", "Specific"];

// The list filter posted with a write (JSON string or object)
function toFilter(value: unknown): PriceListFilterDto {
  if (typeof value === "string") {
    try {
      return (JSON.parse(value || "{}") as PriceListFilterDto) ?? {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as PriceListFilterDto) : {};
}

// Audit shape of a price list (CI3 _priceListToAuditArray)
const auditValues = (data: Record<string, unknown> | null) =>
  data
    ? {
        Name: data.Name ?? "",
        Status: data.Status ?? "",
        Priority: data.Priority ?? "",
        ValidFrom: data.ValidFrom ?? "",
        ValidTo: data.ValidTo ?? "",
        Description: data.Description ?? "",
        AssignedToType: data.AssignedToType ?? "",
        Scope: data.Scope ?? "",
        GlobalBasedOn: data.GlobalBasedOn ?? "",
        Assignments: data.Assignments ?? [],
        Discounts: data.Discounts ?? [],
        Rules: data.Rules ?? [],
      }
    : {};

/** Price lists (CI3 Products controller price-list actions). */
@Injectable()
export class PriceListsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly priceLists: PriceListsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly text: ProductTextService,
    private readonly cache: ProductCacheService,
    private readonly audit: AuditLogService
  ) {}

  // getPriceListData
  async getPage(orgUID: number, pageNo: number, dto: PriceListListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    return this.page(orgUID, pageNo, rowLimit, dto.Filter ?? {}, dto.langCode);
  }

  // getPriceListForEdit
  async getForEdit(orgUID: number, priceListUID: number, langCode: string) {
    if (priceListUID <= 0) throw new CiValidationError("Invalid price list ID.");
    const data = await this.priceLists.findForEdit(orgUID, priceListUID, langCode);
    if (!data) throw new CiValidationError("Price list not found.");
    return { Data: data };
  }

  // savePriceList — header and children in one transaction (on edit the old children are replaced)
  async save(form: PriceListFormDto, ctx: WriteContext) {
    const priceListUID = postInt(form, "PLUID");
    const isEdit = priceListUID > 0;
    const names = await this.text.normalize(postString(form, "Name"), postString(form, "Description"));
    if (!names.name) throw new CiValidationError("Price list name is required.");
    const assignedTo = postString(form, "AssignedToType", "All") as string;
    if (!ASSIGNED_TO.includes(assignedTo)) throw new CiValidationError("Invalid Assigned To value.");
    const scope = postString(form, "Scope", "All") as string;
    if (!SCOPES.includes(scope)) throw new CiValidationError("Invalid Scope value.");
    const discounts = postJsonArray<Record<string, unknown>>(form, "Discounts");
    const rules = postJsonArray<Record<string, unknown>>(form, "Rules");
    const assignments = postJsonArray<unknown>(form, "Assignments").map(toInt).filter((uid) => uid > 0);
    if (scope === "Specific" && rules.length === 0) throw new CiValidationError("Add at least one product rule for Specific Products scope.");

    const before = isEdit ? await this.priceLists.findForEdit(ctx.orgUID, priceListUID) : null;
    if (isEdit && !before) throw new CiValidationError("Price list not found.");
    const header = {
      Name: names.name,
      Status: toInt(postValue(form, "Status", 1)),
      Priority: Math.max(1, toInt(postValue(form, "Priority", 1))),
      ValidFrom: postString(form, "ValidFrom", "") ?? "",
      ValidTo: postString(form, "ValidTo", "") ?? "",
      Description: names.description ?? "",
      AssignedToType: assignedTo,
      Scope: scope,
      GlobalBasedOn: postString(form, "GlobalBasedOn", "SellingPrice") ?? "SellingPrice",
    };

    const uid = await this.db.transaction(async (trx) => {
      const id = await this.priceLists.saveHeader(trx, ctx.orgUID, priceListUID, header, ctx.userUID);
      if (isEdit) await this.priceLists.softDeleteChildren(trx, ctx.orgUID, id);
      if (assignedTo !== "All" && assignments.length > 0) {
        await this.priceLists.saveAssignments(trx, ctx.orgUID, id, assignedTo === "Groups" ? "Group" : "Customer", assignments);
      }
      if (scope === "All" && discounts.length > 0) await this.priceLists.saveDiscounts(trx, ctx.orgUID, id, discounts);
      if (scope === "Specific") await this.priceLists.saveRules(trx, ctx.orgUID, id, rules);
      return id;
    });

    await this.cache.refreshPriceList(ctx.orgUID, uid);
    this.text.scheduleTamil(`price list ${uid}`, names.typed, (name, description) => this.priceLists.saveLangRow(uid, "ta", name, description, ctx.userUID));
    await this.audit.log(ctx, {
      action: isEdit ? "UPDATE" : "CREATE",
      entityType: "PriceList",
      entityUID: uid,
      entityRef: names.name,
      summary: `${isEdit ? "Price list updated: " : "Price list created: "}${names.name}`,
      module: "PriceList",
      category: "MASTER",
      oldValues: auditValues(before as Record<string, unknown> | null),
      newValues: { Header: header, Assignments: assignments, Discounts: discounts, Rules: rules },
    });
    return {
      Message: isEdit ? "Price list updated successfully." : "Price list created successfully.",
      PriceListUID: uid,
      ...(await this.refreshPage(form, ctx.orgUID)),
    };
  }

  // deletePriceList
  async delete(dto: PriceListDeleteDto, ctx: WriteContext) {
    const priceListUID = postInt(dto, "PriceListUID");
    if (priceListUID <= 0) throw new CiValidationError("Invalid price list ID.");
    const before = await this.priceLists.findForEdit(ctx.orgUID, priceListUID);
    if (!before) throw new CiValidationError("Price list not found.");
    await this.remove(ctx, priceListUID, before);
    return { Message: "Price list deleted successfully.", ...(await this.refreshPage(dto, ctx.orgUID)) };
  }

  // deleteBulkPriceList — comma-separated PriceListUIDs; unknown ones are skipped
  async deleteBulk(dto: PriceListBulkDeleteDto, ctx: WriteContext) {
    const uids = String(postValue(dto, "PriceListUIDs", "") ?? "")
      .split(",")
      .map((uid) => parseInt(uid, 10))
      .filter((uid) => uid > 0);
    if (uids.length === 0) throw new CiValidationError("No price list IDs provided.");
    for (const uid of uids) {
      const before = await this.priceLists.findForEdit(ctx.orgUID, uid);
      if (before) await this.remove(ctx, uid, before);
    }
    return { Message: `${uids.length} price list(s) deleted successfully.`, ...(await this.refreshPage(dto, ctx.orgUID)) };
  }

  // syncPriceListCache
  async syncCache(orgUID: number) {
    const lists = await this.cache.syncPriceLists(orgUID);
    return { Lists: lists, Message: `${lists.length} price list(s) synced to cache.` };
  }

  private async remove(ctx: WriteContext, priceListUID: number, before: Record<string, unknown>) {
    await this.priceLists.softDelete(ctx.orgUID, priceListUID, ctx.userUID);
    await this.cache.removePriceList(ctx.orgUID, priceListUID);
    await this.audit.log(ctx, {
      action: "DELETE",
      entityType: "PriceList",
      entityUID: priceListUID,
      entityRef: String(before.Name ?? ""),
      summary: `Price list deleted: ${before.Name ?? ""}`,
      module: "PriceList",
      category: "MASTER",
      oldValues: auditValues(before),
    });
  }

  // The price lists page shown after a change (CI3 _appendPriceListRefresh: PageNo, RowLimit default 10, Filter)
  private async refreshPage(dto: { PageNo?: string | number; RowLimit?: string | number; Filter?: unknown }, orgUID: number) {
    const page = await this.page(orgUID, Math.max(1, postInt(dto, "PageNo") || 1), postInt(dto, "RowLimit") || 10, toFilter(dto.Filter), "en");
    return { Data: page.Data, TotalCount: page.TotalCount, PageNo: page.PageNo, RowLimit: page.RowLimit };
  }

  private async page(orgUID: number, pageNo: number, rowLimit: number, filter: PriceListFilterDto, langCode: string) {
    const page = Math.max(1, pageNo);
    const result = await this.priceLists.listPaginated(orgUID, page, rowLimit, filter, langCode);
    return { Data: result.rows, TotalCount: result.totalCount, PageNo: page, RowLimit: rowLimit };
  }
}
