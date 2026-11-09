import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

// Customer group list filter the CI3 groups tab posts
export interface GroupExportFilter {
  SearchAllData?: string;
  IsActive?: string | number;
  GroupType?: string | string[];
  CustomerUID?: string | number;
}

/** Export-only reads (CI3 Products_model::getProductsForExport, Customers_model::getCustomerGroupsForExport). */
@Injectable()
export class ExportsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getProductsForExport — every live product of the org by name (active and inactive), stock summed over variants
  products(orgUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const k = this.read;
    const query = k("Products.ProductTbl as Products")
      .select(
        this.langColumn(useLang, "PL.ItemName", "Products.ItemName", "ItemName"),
        this.langColumn(useLang, "CL.Name", "Category.Name", "CategoryName"),
        "Products.HSNSACCode",
        "Products.PartNumber",
        "Products.SellingPrice",
        "Products.TaxPercentage",
        "Products.PurchasePrice",
        k.raw(
          `CASE WHEN (Products.IsSizeApplicable = 1 OR Products.IsBrandApplicable = 1)
             THEN COALESCE((SELECT SUM(pvs2.AvailableQty) FROM Products.ProductVariantStockTbl pvs2
                  JOIN Products.ProductVariantTbl pv2 ON pv2.VariantUID = pvs2.VariantUID AND pv2.OrgUID = pvs2.OrgUID
                  WHERE pv2.ProductUID = Products.ProductUID AND pvs2.OrgUID = Products.OrgUID AND pv2.IsActive = 1), 0)
             ELSE COALESCE(ProductStock.AvailableQty, 0) END AS AvailableQuantity`
        ),
        k.raw("BIT_COUNT(??) AS ??", ["Products.IsActive", "IsActive"]),
        "Products.UpdatedOn",
        k.raw("CONCAT(??, ' ', ??) AS ??", ["User.FirstName", "User.LastName", "UpdatedBy"])
      )
      .leftJoin("Products.CategoryTbl as Category", "Category.CategoryUID", "Products.CategoryUID")
      .leftJoin("Products.ProductStockTbl as ProductStock", "ProductStock.ProductUID", "Products.ProductUID")
      .leftJoin("Users.UserTbl as User", "User.UserUID", "Products.UpdatedBy")
      .where({ "Products.IsDeleted": 0, "Products.OrgUID": orgUID })
      .orderBy("Products.ItemName", "asc");
    if (useLang) {
      query
        .leftJoin("Products.ProductTbl_Lang as PL", (on) => on.on("PL.ProductUID", "Products.ProductUID").andOnVal("PL.LangCode", "=", langCode))
        .leftJoin("Products.CategoryTbl_Lang as CL", (on) => on.on("CL.CategoryUID", "Category.CategoryUID").andOnVal("CL.LangCode", "=", langCode));
    }
    return query;
  }

  // getCustomerGroupsForExport — groups by name with member count, then the members' receivable / payable totals
  async customerGroups(orgUID: number, filter: GroupExportFilter, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const k = this.read;
    const query = k("Customers.CustomerGroupTbl as CG")
      .select(
        "CG.GroupUID",
        "CG.GroupCode",
        this.langColumn(useLang, "CGL.GroupName", "CG.GroupName", "GroupName"),
        "CG.GroupType",
        this.langColumn(useLang, "CGL.ContactPerson", "CG.ContactPerson", "ContactPerson"),
        "CG.Mobile",
        "CG.Email",
        k.raw("BIT_COUNT(??) AS ??", ["CG.IsActive", "IsActive"]),
        k.raw("COUNT(??) AS ??", ["CGM.CustomerUID", "MemberCount"])
      )
      .leftJoin("Customers.CustGroupMemberTbl as CGM", (on) => on.on("CGM.GroupUID", "CG.GroupUID").andOn("CGM.OrgUID", "CG.OrgUID").andOnVal("CGM.IsDeleted", "=", 0))
      .where({ "CG.OrgUID": orgUID, "CG.IsDeleted": 0 })
      .groupBy("CG.GroupUID")
      .orderBy("GroupName", "asc");
    if (useLang) query.leftJoin("Customers.CustomerGroupTbl_Lang as CGL", (on) => on.on("CGL.GroupUID", "CG.GroupUID").andOnVal("CGL.LangCode", "=", langCode));
    const search = String(filter.SearchAllData ?? "").trim();
    if (search) this.whereAnyLike(query, ["CG.GroupName", "CG.GroupCode", "CG.GroupType", "CG.Mobile"], search);
    if (filter.IsActive !== undefined && filter.IsActive !== "") query.where("CG.IsActive", Number(filter.IsActive) ? 1 : 0);
    const types = ([] as unknown[]).concat(filter.GroupType ?? []).map(String).filter(Boolean);
    if (types.length) query.whereIn("CG.GroupType", types);
    const customerUID = parseInt(String(filter.CustomerUID ?? ""), 10);
    if (customerUID > 0) {
      query.whereIn("CG.GroupUID", (sub) => sub.select("GroupUID").from("Customers.CustGroupMemberTbl").where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 }));
    }
    const rows: Row[] = await query;
    if (rows.length === 0) return rows;

    const balances: Row[] = await k("Customers.CustGroupMemberTbl as CGM")
      .select(
        "CGM.GroupUID",
        k.raw("COALESCE(SUM(CASE WHEN ?? = 'Debit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", ["COB.PendingBalType", "COB.PendingBalance", "COB.PendingBalance", "TotalReceivable"]),
        k.raw("COALESCE(SUM(CASE WHEN ?? = 'Credit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", ["COB.PendingBalType", "COB.PendingBalance", "COB.PendingBalance", "TotalPayable"])
      )
      .join("Customers.CustOpeningBalanceTbl as COB", (on) => on.on("COB.CustomerUID", "CGM.CustomerUID").andOn("COB.OrgUID", "CGM.OrgUID").andOnVal("COB.IsDeleted", "=", 0))
      .where({ "CGM.OrgUID": orgUID, "CGM.IsDeleted": 0 })
      .whereIn("CGM.GroupUID", rows.map((row) => Number(row.GroupUID)))
      .groupBy("CGM.GroupUID");
    const byGroup = new Map(balances.map((row) => [Number(row.GroupUID), row]));
    return rows.map((row) => {
      const balance = byGroup.get(Number(row.GroupUID));
      return { ...row, TotalReceivable: Number(balance?.TotalReceivable ?? 0), TotalPayable: Number(balance?.TotalPayable ?? 0) };
    });
  }

  // JwtData->User->UILanguage — names are exported in the user's language
  async userLanguage(orgUID: number, userUID: number): Promise<string> {
    const row = await this.read("Users.UserTbl").select("UILanguage").where({ UserUID: userUID, OrgUID: orgUID }).first();
    return String(row?.UILanguage || "en");
  }

  // GenSettings->ListDateFormat (CI3 default d-m-Y)
  async listDateFormat(orgUID: number): Promise<string> {
    const row = await this.read("Settings.OrgSettingsTbl").select("ListDateFormat").where({ OrgUID: orgUID }).first();
    return String(row?.ListDateFormat || "d-m-Y");
  }
}
