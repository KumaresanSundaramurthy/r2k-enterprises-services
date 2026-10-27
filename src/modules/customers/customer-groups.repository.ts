import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { toInt } from "../../common/utils/php-compat";
import { GroupListFilterDto } from "./dto/customer-group.dto";
import { Row } from "./customers.repository";

// CI3 falls back to this list when Global.GroupTypesTbl has no rows for the module
const DEFAULT_GROUP_TYPES = [
  "Business Group",
  "Branch Group",
  "Family Group",
  "Corporate Group",
  "Dealer Network",
  "Franchise Group",
  "Custom",
];
const GROUP_SEARCH_COLUMNS = ["CG.GroupName", "CG.GroupCode", "CG.GroupType", "CG.Mobile"];

export interface GroupDropdownRow {
  GroupUID: string;
  GroupName: string | null;
  GroupCode: string | null;
  GroupType: string | null;
}

// Customer group queries (CI3 Customers_model group section).
@Injectable()
export class CustomerGroupsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getGroupListPaginated — groups with member count, primary member and receivable/payable totals.
  async listPaginated(orgUID: number, pageNo: number, limit: number, filter: GroupListFilterDto, langCode: string) {
    const countRow = await this.applyListFilters(this.read("Customers.CustomerGroupTbl as CG").count({ cnt: "*" }), orgUID, filter).first();
    const totalCount = toInt(countRow?.cnt);

    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Customers.CustomerGroupTbl as CG")
      .select(
        "CG.GroupUID as GroupUID",
        "CG.GroupCode as GroupCode",
        this.langColumn(useLang, "CGL.GroupName", "CG.GroupName", "GroupName"),
        "CG.GroupType as GroupType",
        this.langColumn(useLang, "CGL.ContactPerson", "CG.ContactPerson", "ContactPerson"),
        "CG.Mobile as Mobile",
        "CG.Email as Email",
        "CG.IsActive as IsActive",
        "CG.CreatedOn as CreatedOn",
        this.read.raw("COUNT(??) AS ??", ["CGM.CustomerUID", "MemberCount"]),
        this.read.raw("MAX(CASE WHEN ?? = 1 THEN ?? ELSE NULL END) AS ??", ["CGM.IsGroupPrimary", "C.Name", "PrimaryName"])
      )
      .leftJoin("Customers.CustGroupMemberTbl as CGM", (on) => {
        on.on("CGM.GroupUID", "CG.GroupUID").andOn("CGM.OrgUID", "CG.OrgUID").andOnVal("CGM.IsDeleted", "=", 0);
      })
      .leftJoin("Customers.CustomerTbl as C", (on) => {
        on.on("C.CustomerUID", "CGM.CustomerUID").andOnVal("C.IsDeleted", "=", 0);
      })
      .groupBy("CG.GroupUID")
      .orderBy("CG.GroupName", "asc")
      .limit(limit)
      .offset(BaseRepository.offset(pageNo, limit));
    if (useLang) {
      query.leftJoin("Customers.CustomerGroupTbl_Lang as CGL", (on) => {
        on.on("CGL.GroupUID", "CG.GroupUID").andOnVal("CGL.LangCode", "=", langCode);
      });
    }
    this.applyListFilters(query, orgUID, filter);
    const rows: Row[] = await query;
    await this.attachBalanceTotals(orgUID, rows);
    return { rows, totalCount };
  }

  // getGroupStats
  async stats(orgUID: number): Promise<Row | null> {
    const row = await this.read("Customers.CustomerGroupTbl")
      .select(
        this.read.raw("COUNT(*) AS ??", ["TotalCount"]),
        this.read.raw("SUM(?? = 1) AS ??", ["IsActive", "ActiveCount"]),
        this.read.raw("SUM(?? = 0) AS ??", ["IsActive", "InactiveCount"]),
        this.read
          .count("*")
          .from("Customers.CustGroupMemberTbl")
          .where({ OrgUID: orgUID, IsDeleted: 0 })
          .as("TotalMembers")
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getGroupByUID
  async findByUID(orgUID: number, groupUID: number): Promise<Row | null> {
    const row = await this.read("Customers.CustomerGroupTbl as CG")
      .select(
        "CG.GroupUID as GroupUID",
        "CG.OrgUID as OrgUID",
        "CG.GroupCode as GroupCode",
        "CG.GroupName as GroupName",
        "CG.GroupType as GroupType",
        "CG.ContactPerson as ContactPerson",
        "CG.Mobile as Mobile",
        "CG.MobileCountryCode as MobileCountryCode",
        "CG.Email as Email",
        "CG.GSTNo as GSTNo",
        "CG.GSTINValidated as GSTINValidated",
        "CG.Address as Address",
        "CG.City as City",
        "CG.State as State",
        "CG.Country as Country",
        "CG.AddrLine1 as AddrLine1",
        "CG.AddrLine2 as AddrLine2",
        "CG.AddrCity as AddrCity",
        "CG.AddrState as AddrState",
        "CG.AddrStateCode as AddrStateCode",
        "CG.AddrPincode as AddrPincode",
        "CG.Notes as Notes",
        "CG.IsActive as IsActive",
        "CG.IsDeleted as IsDeleted",
        "CG.CreatedBy as CreatedBy",
        "CG.UpdatedBy as UpdatedBy",
        "CG.CreatedOn as CreatedOn",
        "CG.UpdatedOn as UpdatedOn"
      )
      .where({ "CG.OrgUID": orgUID, "CG.GroupUID": groupUID, "CG.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // getGroupMembers / getGroupOutstanding (same query in CI3) — members with their closing balance, primary first.
  async findMembersWithBalance(orgUID: number, groupUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Customers.CustomerTbl as C")
      .select(
        "C.CustomerUID as CustomerUID",
        this.langColumn(useLang, "CL.Name", "C.Name", "Name"),
        this.langColumn(useLang, "CL.Area", "C.Area", "Area"),
        "C.MobileNumber as MobileNumber",
        "CGM.IsGroupPrimary as IsGroupPrimary",
        this.read.raw("IFNULL(??, 0) AS ??", ["COB.PendingBalance", "Balance"]),
        this.read.raw("IFNULL(??, 'Debit') AS ??", ["COB.PendingBalType", "BalanceType"])
      )
      .join("Customers.CustGroupMemberTbl as CGM", (on) => {
        on.on("CGM.CustomerUID", "C.CustomerUID").andOn("CGM.OrgUID", "C.OrgUID").andOnVal("CGM.IsDeleted", "=", 0);
      })
      .leftJoin("Customers.CustOpeningBalanceTbl as COB", (on) => {
        on.on("COB.CustomerUID", "C.CustomerUID").andOn("COB.OrgUID", "C.OrgUID").andOnVal("COB.IsDeleted", "=", 0);
      })
      .where({ "C.OrgUID": orgUID, "CGM.GroupUID": groupUID, "C.IsDeleted": 0 })
      .orderBy([
        { column: "CGM.IsGroupPrimary", order: "desc" },
        { column: "C.Name", order: "asc" },
      ]);
    if (useLang) {
      query.leftJoin("Customers.CustomersTbl_Lang as CL", (on) => {
        on.on("CL.CustomerUID", "C.CustomerUID").andOnVal("CL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getGroupOverview — member count and the group's combined receivable / payable.
  async overview(orgUID: number, groupUID: number): Promise<Row | null> {
    const row = await this.read("Customers.CustomerTbl as C")
      .select(
        this.read.raw("COUNT(??) AS ??", ["C.CustomerUID", "MemberCount"]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'Debit' THEN ?? END), 0) AS ??", ["COB.PendingBalType", "COB.PendingBalance", "TotalReceivable"]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'Credit' THEN ?? END), 0) AS ??", ["COB.PendingBalType", "COB.PendingBalance", "TotalPayable"])
      )
      .join("Customers.CustGroupMemberTbl as CGM", (on) => {
        on.on("CGM.CustomerUID", "C.CustomerUID").andOn("CGM.OrgUID", "C.OrgUID").andOnVal("CGM.IsDeleted", "=", 0);
      })
      .leftJoin("Customers.CustOpeningBalanceTbl as COB", (on) => {
        on.on("COB.CustomerUID", "C.CustomerUID").andOn("COB.OrgUID", "C.OrgUID").andOnVal("COB.IsDeleted", "=", 0);
      })
      .where({ "CGM.GroupUID": groupUID, "C.OrgUID": orgUID, "C.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // getActiveGroupsForDropdown
  async findActiveForDropdown(orgUID: number, langCode: string): Promise<GroupDropdownRow[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Customers.CustomerGroupTbl as cg")
      .select(
        "cg.GroupUID as GroupUID",
        this.langColumn(useLang, "cgl.GroupName", "cg.GroupName", "GroupName"),
        "cg.GroupCode as GroupCode",
        "cg.GroupType as GroupType"
      )
      .where({ "cg.OrgUID": orgUID, "cg.IsActive": 1, "cg.IsDeleted": 0 })
      .orderBy("cg.GroupName", "asc");
    if (useLang) {
      query.leftJoin("Customers.CustomerGroupTbl_Lang as cgl", (on) => {
        on.on("cgl.GroupUID", "cg.GroupUID").andOnVal("cgl.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getGroupTypes — type names for a module, or CI3's default list when none are configured.
  async findGroupTypes(module: string): Promise<string[]> {
    const rows: { TypeName: string }[] = await this.read("Global.GroupTypesTbl")
      .select("TypeName")
      .where({ Module: module, IsActive: 1 })
      .orderBy("SortOrder", "asc");
    return rows.length > 0 ? rows.map((row) => row.TypeName) : [...DEFAULT_GROUP_TYPES];
  }

  // getGroupDropdownDataByUID — an active group as cached for the dropdown
  async findActiveDropdownRow(orgUID: number, groupUID: number): Promise<GroupDropdownRow | null> {
    const row = await this.read("Customers.CustomerGroupTbl")
      .select("GroupUID", "GroupName", "GroupCode", "GroupType")
      .where({ OrgUID: orgUID, GroupUID: groupUID, IsActive: 1, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // CustomerUIDs currently in the group
  async findMemberUIDs(orgUID: number, groupUID: number): Promise<number[]> {
    const rows: { CustomerUID: string }[] = await this.read("Customers.CustGroupMemberTbl")
      .select("CustomerUID")
      .where({ OrgUID: orgUID, GroupUID: groupUID, IsDeleted: 0 });
    return rows.map((row) => toInt(row.CustomerUID));
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async insertGroup(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number> {
    const [groupUID] = await trx("Customers.CustomerGroupTbl").insert(row);
    return groupUID;
  }

  async updateGroup(orgUID: number, groupUID: number, data: Record<string, unknown>, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)("Customers.CustomerGroupTbl").where({ GroupUID: groupUID, OrgUID: orgUID }).update(data);
  }

  // assignGroupMembers — each customer belongs to one group (unique OrgUID + CustomerUID), so this also moves them.
  async assignMembers(trx: Knex.Transaction, orgUID: number, groupUID: number, memberUIDs: number[], primaryUID: number, userUID: number) {
    for (const customerUID of memberUIDs) {
      const isPrimary = customerUID === primaryUID ? 1 : 0;
      await trx("Customers.CustGroupMemberTbl")
        .insert({ OrgUID: orgUID, CustomerUID: customerUID, GroupUID: groupUID, IsGroupPrimary: isPrimary, IsDeleted: 0, CreatedBy: userUID, UpdatedBy: userUID })
        .onConflict(["OrgUID", "CustomerUID"])
        .merge({ GroupUID: groupUID, IsGroupPrimary: isPrimary, IsDeleted: 0, UpdatedBy: userUID });
    }
  }

  // syncGroupMembers — removes customers no longer listed, then assigns the list.
  async syncMembers(trx: Knex.Transaction, orgUID: number, groupUID: number, memberUIDs: number[], primaryUID: number, userUID: number) {
    const removed = trx("Customers.CustGroupMemberTbl").where({ OrgUID: orgUID, GroupUID: groupUID, IsDeleted: 0 });
    if (memberUIDs.length > 0) removed.whereNotIn("CustomerUID", memberUIDs);
    await removed.update({ IsDeleted: 1, UpdatedBy: userUID });
    await this.assignMembers(trx, orgUID, groupUID, memberUIDs, primaryUID, userUID);
  }

  // saveCustomerGroupLangRow — translated group text (one row per group and language).
  async saveLangRow(groupUID: number, langCode: string, text: Record<string, string | null>, userUID: number): Promise<void> {
    await this.writer()("Customers.CustomerGroupTbl_Lang")
      .insert({ GroupUID: groupUID, LangCode: langCode, ...text, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["GroupUID", "LangCode"])
      .merge([...Object.keys(text), "UpdatedBy"]);
  }

  // Shared by the count and the data query, so both always use the same conditions.
  private applyListFilters(query: Knex.QueryBuilder, orgUID: number, filter: GroupListFilterDto): Knex.QueryBuilder {
    query.where({ "CG.OrgUID": orgUID, "CG.IsDeleted": 0 });
    if (filter.SearchAllData) this.whereAnyLike(query, GROUP_SEARCH_COLUMNS, filter.SearchAllData);
    if (filter.IsActive !== undefined) query.where("CG.IsActive", filter.IsActive);
    if (filter.GroupType?.length) query.whereIn("CG.GroupType", filter.GroupType);
    if (filter.CustomerUID) {
      const customerUID = filter.CustomerUID;
      query.whereIn("CG.GroupUID", (sub) => {
        sub
          .select("GroupUID")
          .from("Customers.CustGroupMemberTbl")
          .where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 });
      });
    }
    return query;
  }

  // Receivable / payable per group, only for the groups on this page (one query).
  private async attachBalanceTotals(orgUID: number, rows: Row[]): Promise<void> {
    for (const row of rows) {
      row.TotalReceivable = "0";
      row.TotalPayable = "0";
    }
    if (rows.length === 0) return;

    const totals: Row[] = await this.read("Customers.CustGroupMemberTbl as CGM")
      .select(
        "CGM.GroupUID as GroupUID",
        this.read.raw(
          "COALESCE(SUM(CASE WHEN ?? = 'Debit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??",
          ["COB.PendingBalType", "COB.PendingBalance", "COB.PendingBalance", "TotalReceivable"]
        ),
        this.read.raw(
          "COALESCE(SUM(CASE WHEN ?? = 'Credit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??",
          ["COB.PendingBalType", "COB.PendingBalance", "COB.PendingBalance", "TotalPayable"]
        )
      )
      .join("Customers.CustOpeningBalanceTbl as COB", (on) => {
        on.on("COB.CustomerUID", "CGM.CustomerUID").andOn("COB.OrgUID", "CGM.OrgUID").andOnVal("COB.IsDeleted", "=", 0);
      })
      .where({ "CGM.OrgUID": orgUID, "CGM.IsDeleted": 0 })
      .whereIn(
        "CGM.GroupUID",
        rows.map((row) => toInt(row.GroupUID))
      )
      .groupBy("CGM.GroupUID");

    const byGroup = new Map(totals.map((total) => [toInt(total.GroupUID), total]));
    for (const row of rows) {
      const total = byGroup.get(toInt(row.GroupUID));
      if (total) {
        row.TotalReceivable = total.TotalReceivable;
        row.TotalPayable = total.TotalPayable;
      }
    }
  }
}
