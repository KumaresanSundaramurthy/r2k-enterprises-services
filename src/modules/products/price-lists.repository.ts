import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { toInt } from "../../common/utils/php-compat";
import { PriceListFilterDto } from "./dto/product-list.dto";
import { Row } from "./products.repository";

export interface PriceListHeader {
  Name: string;
  Status: number;
  Priority: number;
  ValidFrom: string;
  ValidTo: string;
  Description: string;
  AssignedToType: string;
  Scope: string;
  GlobalBasedOn: string;
}

export interface PriceListCacheEntry {
  PriceListUID: number;
  Priority: number;
  [key: string]: unknown;
}

// Price lists, their assignments, discounts and product rules (CI3 Pricelists_model).
@Injectable()
export class PriceListsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getPriceListPaginated
  async listPaginated(orgUID: number, pageNo: number, limit: number, filter: PriceListFilterDto, langCode: string) {
    const base = (query: Knex.QueryBuilder) => {
      query.where({ "PL.OrgUID": orgUID, "PL.IsDeleted": 0 });
      const search = (filter.SearchAllData ?? "").trim();
      if (search) query.where("PL.Name", "like", BaseRepository.likePattern(search));
      if (filter.StatusFilter?.length) query.whereIn("PL.Status", filter.StatusFilter);
      if (filter.AssignedToFilter?.length) query.whereIn("PL.AssignedToType", filter.AssignedToFilter);
      if (filter.ScopeFilter?.length) query.whereIn("PL.Scope", filter.ScopeFilter);
      if (filter.LastUpdatedFilter?.length) query.whereIn("PL.UpdatedBy", filter.LastUpdatedFilter);
      return query;
    };
    const countRow = await base(this.read("Products.PriceListTbl as PL").count({ cnt: "PL.PriceListUID" })).first();

    const useLang = BaseRepository.useLang(langCode);
    const query = base(
      this.read("Products.PriceListTbl as PL")
        .select(
          "PL.PriceListUID as PriceListUID",
          this.langColumn(useLang, "PLL.Name", "PL.Name", "Name"),
          "PL.AssignedToType as AssignedToType",
          "PL.Scope as Scope",
          "PL.GlobalBasedOn as GlobalBasedOn",
          "PL.Status as Status",
          "PL.Priority as Priority",
          "PL.ValidFrom as ValidFrom",
          "PL.ValidTo as ValidTo",
          "PL.UpdatedAt as UpdatedAt",
          this.read.raw("CONCAT(??, ' ', ??) AS ??", ["U.FirstName", "U.LastName", "UpdatedByName"])
        )
        .leftJoin("Users.UserTbl as U", "U.UserUID", "PL.UpdatedBy")
        .limit(limit)
        .offset(BaseRepository.offset(pageNo, limit))
    );
    if (useLang) {
      query.leftJoin("Products.PriceListTbl_Lang as PLL", (on) => {
        on.on("PLL.PriceListUID", "PL.PriceListUID").andOnVal("PLL.LangCode", "=", langCode);
      });
    }
    if (filter.NameSorting) query.orderBy("PL.Name", Number(filter.NameSorting) === 1 ? "asc" : "desc");
    if (filter.StatusSorting) query.orderBy("PL.Status", Number(filter.StatusSorting) === 1 ? "asc" : "desc");
    if (!filter.NameSorting && !filter.StatusSorting) query.orderBy("PL.PriceListUID", "desc");
    return { rows: (await query) as Row[], totalCount: toInt(countRow?.cnt) };
  }

  // getByUID — the header (translated name / description when asked for)
  async findHeader(orgUID: number, priceListUID: number, langCode = "en"): Promise<Row | null> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.PriceListTbl as PL")
      .select(
        "PL.PriceListUID as PriceListUID",
        "PL.OrgUID as OrgUID",
        this.langColumn(useLang, "PLL.Name", "PL.Name", "Name"),
        "PL.Status as Status",
        "PL.Priority as Priority",
        "PL.ValidFrom as ValidFrom",
        "PL.ValidTo as ValidTo",
        this.langColumn(useLang, "PLL.Description", "PL.Description", "Description"),
        "PL.AssignedToType as AssignedToType",
        "PL.Scope as Scope",
        "PL.GlobalBasedOn as GlobalBasedOn",
        "PL.IsDeleted as IsDeleted",
        "PL.CreatedBy as CreatedBy",
        "PL.UpdatedBy as UpdatedBy",
        "PL.CreatedAt as CreatedAt",
        "PL.UpdatedAt as UpdatedAt"
      )
      .where({ "PL.OrgUID": orgUID, "PL.PriceListUID": priceListUID, "PL.IsDeleted": 0 });
    if (useLang) {
      query.leftJoin("Products.PriceListTbl_Lang as PLL", (on) => {
        on.on("PLL.PriceListUID", "PL.PriceListUID").andOnVal("PLL.LangCode", "=", langCode);
      });
    }
    const row = await query.first();
    return row ?? null;
  }

  // getForEdit — header with assignments, discounts and rules (rules with product / brand / size names)
  async findForEdit(orgUID: number, priceListUID: number, langCode = "en") {
    const header = await this.findHeader(orgUID, priceListUID, langCode);
    if (!header) return null;
    const useLang = BaseRepository.useLang(langCode);
    const children = { PriceListUID: priceListUID, OrgUID: orgUID, IsDeleted: 0 };
    const rulesQuery = this.read("Products.PriceListRuleTbl as R")
      .select(
        "R.ProductUID as ProductUID",
        "R.VariantUID as VariantUID",
        this.langColumn(useLang, "PTL.ItemName", "P.ItemName", "ProductName"),
        "R.MinQty as MinQty",
        "R.MaxQty as MaxQty",
        "R.CustomerTypeUID as CustomerTypeUID",
        "R.Price as Price",
        useLang ? this.read.raw("COALESCE(??, ??, '') AS ??", ["BL.BrandName", "b.BrandName", "BrandName"]) : this.read.raw("COALESCE(??, '') AS ??", ["b.BrandName", "BrandName"]),
        useLang ? this.read.raw("COALESCE(??, ??, '') AS ??", ["SZL.Name", "sz.Name", "SizeName"]) : this.read.raw("COALESCE(??, '') AS ??", ["sz.Name", "SizeName"])
      )
      .leftJoin("Products.ProductTbl as P", "P.ProductUID", "R.ProductUID")
      .leftJoin("Products.ProductVariantTbl as pv", (on) => {
        on.on("pv.VariantUID", "R.VariantUID").andOn("pv.OrgUID", "R.OrgUID");
      })
      .leftJoin("Products.BrandTbl as b", (on) => {
        on.on("b.BrandUID", "pv.BrandUID").andOnVal("pv.BrandUID", ">", 0);
      })
      .leftJoin("Products.SizeTbl as sz", (on) => {
        on.on("sz.SizeUID", "pv.SizeUID").andOnVal("pv.SizeUID", ">", 0);
      })
      .where({ "R.PriceListUID": priceListUID, "R.OrgUID": orgUID, "R.IsDeleted": 0 })
      .orderBy([
        { column: "R.ProductUID", order: "asc" },
        { column: "R.VariantUID", order: "asc" },
        { column: "R.MinQty", order: "asc" },
      ]);
    if (useLang) {
      rulesQuery
        .leftJoin("Products.ProductTbl_Lang as PTL", (on) => {
          on.on("PTL.ProductUID", "R.ProductUID").andOnVal("PTL.LangCode", "=", langCode);
        })
        .leftJoin("Products.BrandTbl_Lang as BL", (on) => {
          on.on("BL.BrandUID", "pv.BrandUID").andOnVal("pv.BrandUID", ">", 0).andOnVal("BL.LangCode", "=", langCode);
        })
        .leftJoin("Products.SizeTbl_Lang as SZL", (on) => {
          on.on("SZL.SizeUID", "pv.SizeUID").andOnVal("pv.SizeUID", ">", 0).andOnVal("SZL.LangCode", "=", langCode);
        });
    }
    const [assignments, discounts, rules] = await Promise.all([
      this.read("Products.PriceListAssignmentTbl").select("RefType", "RefUID").where(children),
      this.read("Products.PriceListDiscountTbl").select("CustomerTypeUID", "DiscountType", "DiscountValue").where(children),
      rulesQuery,
    ]);
    return { ...header, Assignments: assignments as Row[], Discounts: discounts as Row[], Rules: rules as Row[] };
  }

  // getAllForCache (priceListUID 0) / getOneForCache — active price lists with their children, highest priority first
  async findForCache(orgUID: number, priceListUID = 0): Promise<PriceListCacheEntry[]> {
    const headersQuery = this.read("Products.PriceListTbl")
      .select("PriceListUID", "Name", "Description", "Status", "Priority", "ValidFrom", "ValidTo", "AssignedToType", "Scope", "GlobalBasedOn")
      .where({ OrgUID: orgUID, IsDeleted: 0, Status: 1 })
      .orderBy("Priority", "desc");
    if (priceListUID > 0) headersQuery.where({ PriceListUID: priceListUID });
    const headers: Row[] = await headersQuery;
    if (headers.length === 0) return [];

    const uids = headers.map((header) => toInt(header.PriceListUID));
    const childOf = (table: string, columns: string[]) =>
      this.read(table)
        .select("PriceListUID", ...columns)
        .where({ OrgUID: orgUID, IsDeleted: 0 })
        .whereIn("PriceListUID", uids);
    const [assignments, discounts, rules]: Row[][] = await Promise.all([
      childOf("Products.PriceListAssignmentTbl", ["RefType", "RefUID"]),
      childOf("Products.PriceListDiscountTbl", ["CustomerTypeUID", "DiscountType", "DiscountValue"]),
      childOf("Products.PriceListRuleTbl", ["ProductUID", "MinQty", "MaxQty", "CustomerTypeUID", "Price"]),
    ]);
    const of = (rows: Row[], uid: number) => rows.filter((row) => toInt(row.PriceListUID) === uid);

    return headers.map((header) => {
      const uid = toInt(header.PriceListUID);
      return {
        PriceListUID: uid,
        Name: header.Name,
        Description: header.Description || null,
        Status: toInt(header.Status),
        Priority: toInt(header.Priority),
        ValidFrom: header.ValidFrom || null,
        ValidTo: header.ValidTo || null,
        AssignedToType: header.AssignedToType,
        Scope: header.Scope,
        GlobalBasedOn: header.GlobalBasedOn,
        Assignments: of(assignments, uid).map((row) => ({ RefType: row.RefType, RefUID: toInt(row.RefUID) })),
        Discounts: of(discounts, uid).map((row) => ({
          CustomerTypeUID: toInt(row.CustomerTypeUID),
          DiscountType: row.DiscountType,
          DiscountValue: Number(row.DiscountValue),
        })),
        Rules: of(rules, uid).map((row) => ({
          ProductUID: toInt(row.ProductUID),
          MinQty: toInt(row.MinQty),
          MaxQty: row.MaxQty !== null ? toInt(row.MaxQty) : null,
          CustomerTypeUID: toInt(row.CustomerTypeUID),
          Price: Number(row.Price),
        })),
      };
    });
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  // createHeader / updateHeader
  async saveHeader(trx: Knex.Transaction, orgUID: number, priceListUID: number, header: PriceListHeader, userUID: number): Promise<number> {
    const row = {
      Name: header.Name,
      Status: header.Status,
      Priority: Math.max(1, header.Priority),
      ValidFrom: header.ValidFrom || null,
      ValidTo: header.ValidTo || null,
      Description: header.Description || null,
      AssignedToType: header.AssignedToType,
      Scope: header.Scope,
      GlobalBasedOn: header.GlobalBasedOn || "SellingPrice",
      UpdatedBy: userUID,
    };
    if (priceListUID > 0) {
      await trx("Products.PriceListTbl").where({ PriceListUID: priceListUID, OrgUID: orgUID }).update(row);
      return priceListUID;
    }
    const [uid] = await trx("Products.PriceListTbl").insert({ ...row, OrgUID: orgUID, CreatedBy: userUID });
    return uid;
  }

  // softDeleteChildRecords — before the children are saved again on update
  async softDeleteChildren(trx: Knex.Transaction, orgUID: number, priceListUID: number): Promise<void> {
    const where = { PriceListUID: priceListUID, OrgUID: orgUID };
    await trx("Products.PriceListAssignmentTbl").where(where).update({ IsDeleted: 1 });
    await trx("Products.PriceListDiscountTbl").where(where).update({ IsDeleted: 1 });
    await trx("Products.PriceListRuleTbl").where(where).update({ IsDeleted: 1 });
  }

  // saveAssignments — restores a soft-deleted row with the same key, else inserts
  async saveAssignments(trx: Knex.Transaction, orgUID: number, priceListUID: number, refType: string, refUIDs: number[]): Promise<void> {
    for (const refUID of refUIDs) {
      const key = { PriceListUID: priceListUID, OrgUID: orgUID, RefType: refType, RefUID: refUID };
      await this.restoreOrInsert(trx, "Products.PriceListAssignmentTbl", "AssignmentUID", key, { IsDeleted: 0 });
    }
  }

  // saveDiscounts — one row per customer type
  async saveDiscounts(trx: Knex.Transaction, orgUID: number, priceListUID: number, rows: Record<string, unknown>[]): Promise<void> {
    for (const row of rows) {
      const key = { PriceListUID: priceListUID, OrgUID: orgUID, CustomerTypeUID: toInt(row.CustomerTypeUID) };
      const data = { DiscountType: row.DiscountType ?? "Percentage", DiscountValue: Number(row.DiscountValue ?? 0) || 0, IsDeleted: 0 };
      await this.restoreOrInsert(trx, "Products.PriceListDiscountTbl", "DiscountUID", key, data);
    }
  }

  // saveRules — one row per product (+ variant) + minimum quantity + customer type
  async saveRules(trx: Knex.Transaction, orgUID: number, priceListUID: number, rows: Record<string, unknown>[]): Promise<void> {
    for (const row of rows) {
      const variantUID = toInt(row.VariantUID) > 0 ? toInt(row.VariantUID) : null;
      const key = {
        PriceListUID: priceListUID,
        OrgUID: orgUID,
        ProductUID: toInt(row.ProductUID),
        MinQty: row.MinQty === undefined || row.MinQty === null ? 1 : toInt(row.MinQty),
        CustomerTypeUID: toInt(row.CustomerTypeUID),
        VariantUID: variantUID,
      };
      const data = {
        MaxQty: row.MaxQty !== undefined && row.MaxQty !== null && row.MaxQty !== "" ? toInt(row.MaxQty) : null,
        Price: Number(row.Price ?? 0) || 0,
        IsDeleted: 0,
      };
      await this.restoreOrInsert(trx, "Products.PriceListRuleTbl", "RuleUID", key, data);
    }
  }

  // softDelete
  async softDelete(orgUID: number, priceListUID: number, userUID: number): Promise<void> {
    await this.writer()("Products.PriceListTbl").where({ PriceListUID: priceListUID, OrgUID: orgUID }).update({ IsDeleted: 1, UpdatedBy: userUID });
  }

  // savePriceListLangRow
  async saveLangRow(priceListUID: number, langCode: string, name: string | null, description: string | null, userUID: number): Promise<void> {
    await this.writer()("Products.PriceListTbl_Lang")
      .insert({ PriceListUID: priceListUID, LangCode: langCode, Name: name, Description: description, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["PriceListUID", "LangCode"])
      .merge(["Name", "Description", "UpdatedBy"]);
  }

  // Updates the row with this natural key (null-safe on VariantUID), or inserts it
  private async restoreOrInsert(trx: Knex.Transaction, table: string, pk: string, key: Record<string, unknown>, data: Record<string, unknown>) {
    const lookup = trx(table).select(pk);
    for (const [column, value] of Object.entries(key)) {
      if (value === null) lookup.whereNull(column);
      else lookup.where(column, value as Knex.Value);
    }
    const existing = await lookup.first();
    if (existing) await trx(table).where({ [pk]: existing[pk] }).update(data);
    else await trx(table).insert({ ...key, ...data });
  }
}
