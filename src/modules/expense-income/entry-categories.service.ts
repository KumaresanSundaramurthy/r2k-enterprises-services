import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";

type Row = Record<string, unknown>;

// Rows per page of the category manager (CI3 getCategoryList)
const CATEGORY_PAGE_SIZE = 30;

/** What differs between the expense and income category lists. */
export interface CategoryKind {
  table: string;
  // Records that use a category, which then cannot be deleted
  recordTable: string;
  // Audit names: CREATE_{action}_CATEGORY, entity type, module and the summary's noun
  auditAction: "EXPENSE" | "INCOME";
  auditEntity: "ExpenseCategory" | "IncomeCategory";
  auditModule: "Expenses" | "IndirectIncome";
  noun: "expense" | "income";
  // Expenses lock the organisation's default categories too; income only the system (no-organisation) ones
  defaultsLocked: boolean;
  inUseMessage: string;
}

export const EXPENSE_CATEGORIES: CategoryKind = {
  table: "Transaction.ExpenseCategoryTbl",
  recordTable: "Transaction.ExpensesTbl",
  auditAction: "EXPENSE",
  auditEntity: "ExpenseCategory",
  auditModule: "Expenses",
  noun: "expense",
  defaultsLocked: true,
  inUseMessage: "This category is linked to one or more expenses and cannot be deleted. Please reassign those expenses first.",
};

export const INCOME_CATEGORIES: CategoryKind = {
  table: "Transaction.IndirectIncomeCategoryTbl",
  recordTable: "Transaction.IndirectIncomeTbl",
  auditAction: "INCOME",
  auditEntity: "IncomeCategory",
  auditModule: "IndirectIncome",
  noun: "income",
  defaultsLocked: false,
  inUseMessage: "This category is used in existing income records and cannot be deleted.",
};

export interface CategoryListQuery {
  pageNo: number;
  search: string;
}

/**
 * Expense / income categories: the organisation's own plus the system ones (OrgUID NULL). CI3 returned the
 * manager's rows as HTML; here each row carries IsSystem (shown with a "System" badge, not editable).
 */
@Injectable()
export class EntryCategoriesService extends BaseRepository {
  constructor(
    db: DatabaseService,
    private readonly audit: AuditLogService
  ) {
    super(db);
  }

  // getCategories — the dropdown
  async dropdown(kind: CategoryKind, orgUID: number): Promise<Row[]> {
    return this.visible(kind, orgUID).select("CategoryUID", "CategoryName").orderBy("CategoryName", "asc");
  }

  // getCategoryList — paged manager list (30 a page)
  async list(kind: CategoryKind, orgUID: number, query: CategoryListQuery) {
    const pageNo = Math.max(1, query.pageNo);
    const [rows, total] = await Promise.all([this.page(kind, orgUID, query.search, pageNo), this.count(kind, orgUID, query.search)]);
    return { Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: CATEGORY_PAGE_SIZE };
  }

  // addCategory
  async add(kind: CategoryKind, ctx: WriteContext, name: string, query: CategoryListQuery | null) {
    const categoryName = name.trim();
    if (!categoryName) throw new CiValidationError("Category name is required.");
    const [categoryUID] = await this.db.write(kind.table).insert({
      OrgUID: ctx.orgUID,
      CategoryName: categoryName,
      IsDefault: 0,
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
    });
    await this.log(kind, ctx, "CREATE", Number(categoryUID), categoryName, `Created ${kind.noun} category ${categoryName}`);
    return { Message: "Category added.", CategoryUID: Number(categoryUID), CategoryName: categoryName, ...(await this.refreshed(kind, ctx.orgUID, query)) };
  }

  // updateCategory — only the organisation's own categories
  async rename(kind: CategoryKind, ctx: WriteContext, categoryUID: number, name: string, query: CategoryListQuery | null) {
    const categoryName = name.trim();
    if (categoryUID <= 0) throw new CiValidationError("Invalid category.");
    if (!categoryName) throw new CiValidationError("Category name is required.");
    await this.db
      .write(kind.table)
      .where({ CategoryUID: categoryUID, OrgUID: ctx.orgUID, IsDeleted: 0 })
      .update({ CategoryName: categoryName, UpdatedBy: ctx.userUID });
    await this.log(kind, ctx, "UPDATE", categoryUID, categoryName, `Updated ${kind.noun} category ${categoryName}`);
    return { Message: "Category updated.", CategoryUID: categoryUID, CategoryName: categoryName, ...(await this.refreshed(kind, ctx.orgUID, query)) };
  }

  // deleteCategory — refused while a live record uses it
  async delete(kind: CategoryKind, ctx: WriteContext, categoryUID: number, query: CategoryListQuery | null) {
    if (categoryUID <= 0) throw new CiValidationError("Invalid category.");
    const used = await this.read(kind.recordTable).count("* as cnt").where({ CategoryUID: categoryUID, OrgUID: ctx.orgUID, IsDeleted: 0 }).first();
    if (Number(used?.cnt ?? 0) > 0) throw new CiValidationError(kind.inUseMessage);
    await this.db
      .write(kind.table)
      .where({ CategoryUID: categoryUID, OrgUID: ctx.orgUID, IsDeleted: 0 })
      .update({ IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    await this.log(kind, ctx, "DELETE", categoryUID, "", `Deleted ${kind.noun} category #${categoryUID}`);
    return { Message: "Category deleted.", CategoryUID: categoryUID, ...(await this.refreshed(kind, ctx.orgUID, query)) };
  }

  // _appendCategoryListResponse (expenses) — the manager's page after a change, a page back when it emptied
  private async refreshed(kind: CategoryKind, orgUID: number, query: CategoryListQuery | null) {
    if (!query) return {};
    let pageNo = Math.max(1, query.pageNo);
    let rows = await this.page(kind, orgUID, query.search, pageNo);
    if (rows.length === 0 && pageNo > 1) {
      pageNo--;
      rows = await this.page(kind, orgUID, query.search, pageNo);
    }
    return { CatData: rows, CatTotalCount: await this.count(kind, orgUID, query.search), CatPageNo: pageNo };
  }

  private async page(kind: CategoryKind, orgUID: number, search: string, pageNo: number): Promise<Row[]> {
    const rows: Row[] = await this.filtered(kind, orgUID, search)
      .select("CategoryUID", "CategoryName", "OrgUID", "IsDefault")
      .orderBy([{ column: "IsDefault", order: "desc" }, { column: "CategoryName", order: "asc" }])
      .limit(CATEGORY_PAGE_SIZE)
      .offset(BaseRepository.offset(pageNo, CATEGORY_PAGE_SIZE));
    return rows.map((row) => {
      const systemOwned = row.OrgUID === null || row.OrgUID === "";
      return { ...row, IsSystem: systemOwned || (kind.defaultsLocked && Number(row.IsDefault) === 1) ? 1 : 0 };
    });
  }

  private async count(kind: CategoryKind, orgUID: number, search: string): Promise<number> {
    const row = await this.filtered(kind, orgUID, search).count("* as cnt").first();
    return Number(row?.cnt ?? 0);
  }

  private filtered(kind: CategoryKind, orgUID: number, search: string) {
    const query = this.visible(kind, orgUID);
    if (search.trim()) query.where("CategoryName", "like", BaseRepository.likePattern(search.trim()));
    return query;
  }

  // Live categories of the organisation and the system ones
  private visible(kind: CategoryKind, orgUID: number) {
    return this.read(kind.table)
      .where({ IsDeleted: 0, IsActive: 1 })
      .where((scope) => scope.where("OrgUID", orgUID).orWhereNull("OrgUID"));
  }

  private log(kind: CategoryKind, ctx: WriteContext, verb: "CREATE" | "UPDATE" | "DELETE", categoryUID: number, ref: string, summary: string) {
    return this.audit.log(ctx, {
      action: `${verb}_${kind.auditAction}_CATEGORY`,
      entityType: kind.auditEntity,
      entityUID: categoryUID,
      entityRef: ref,
      summary,
      module: kind.auditModule,
      category: "MASTER",
    });
  }
}
