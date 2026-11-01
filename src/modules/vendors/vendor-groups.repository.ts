import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { CiValidationError } from "../../core/response/ci-response";
import { toInt } from "../../common/utils/php-compat";
import { VendorGroupListFilterDto } from "./dto/vendor-group.dto";
import { Row } from "./vendors.repository";

// CI3 falls back to this list when Global.GroupTypesTbl has no rows for the module
const DEFAULT_GROUP_TYPES = ["Business Group", "Branch Group", "Family Group", "Corporate Group", "Dealer Network", "Franchise Group", "Custom"];
const GROUP_SEARCH_COLUMNS = ["VG.GroupName", "VG.GroupCode", "VG.GroupType", "VG.Mobile"];
const TYPEAHEAD_SEARCH_COLUMNS = ["V.Name", "V.MobileNumber", "V.Area"];
const MEMBER_TABLE = "VendorGroupMemberTbl";

export interface VendorGroupDropdownRow {
  GroupUID: string;
  GroupName: string | null;
  GroupCode: string | null;
  GroupType: string | null;
}

/**
 * Vendor group queries (CI3 Vendors_model group section). Membership lives in Vendors.VendorGroupMemberTbl;
 * like CI3's list and stats, reads check that table exists and behave as "no members" when it does not.
 */
@Injectable()
export class VendorGroupsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  hasMemberTable(): Promise<boolean> {
    return this.tableExists("Vendors", MEMBER_TABLE);
  }

  // getVendorGroupListPaginated — groups with member count, primary member and receivable/payable totals.
  async listPaginated(orgUID: number, pageNo: number, limit: number, filter: VendorGroupListFilterDto, langCode: string) {
    const hasMembers = await this.hasMemberTable();
    const countRow = await this.applyListFilters(this.read("Vendors.VendorGroupTbl as VG").count({ cnt: "*" }), orgUID, filter, hasMembers).first();
    const totalCount = toInt(countRow?.cnt);

    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Vendors.VendorGroupTbl as VG")
      .select(
        "VG.GroupUID as GroupUID",
        "VG.GroupCode as GroupCode",
        this.langColumn(useLang, "VGL.GroupName", "VG.GroupName", "GroupName"),
        "VG.GroupType as GroupType",
        this.langColumn(useLang, "VGL.ContactPerson", "VG.ContactPerson", "ContactPerson"),
        "VG.Mobile as Mobile",
        "VG.Email as Email",
        "VG.IsActive as IsActive",
        hasMembers ? this.read.raw("COUNT(??) AS ??", ["V.VendorUID", "MemberCount"]) : this.read.raw("0 AS ??", ["MemberCount"]),
        hasMembers
          ? this.read.raw("MAX(CASE WHEN ?? = 1 THEN ?? ELSE NULL END) AS ??", ["VGM.IsGroupPrimary", "V.Name", "PrimaryName"])
          : this.read.raw("NULL AS ??", ["PrimaryName"])
      )
      .groupBy("VG.GroupUID")
      .orderBy("VG.GroupName", "asc")
      .limit(limit)
      .offset(BaseRepository.offset(pageNo, limit));
    if (useLang) {
      query.leftJoin("Vendors.VendorGroupTbl_Lang as VGL", (on) => {
        on.on("VGL.GroupUID", "VG.GroupUID").andOnVal("VGL.LangCode", "=", langCode);
      });
    }
    if (hasMembers) {
      query
        .leftJoin("Vendors.VendorGroupMemberTbl as VGM", (on) => {
          on.on("VGM.GroupUID", "VG.GroupUID").andOn("VGM.OrgUID", "VG.OrgUID").andOnVal("VGM.IsDeleted", "=", 0);
        })
        .leftJoin("Vendors.VendorTbl as V", (on) => {
          on.on("V.VendorUID", "VGM.VendorUID").andOnVal("V.IsDeleted", "=", 0);
        });
    }
    this.applyListFilters(query, orgUID, filter, hasMembers);
    const rows: Row[] = await query;
    await this.attachBalanceTotals(orgUID, rows, hasMembers);
    return { rows, totalCount };
  }

  // getVendorGroupStats
  async stats(orgUID: number): Promise<Row | null> {
    const hasMembers = await this.hasMemberTable();
    const row = await this.read("Vendors.VendorGroupTbl")
      .select(
        this.read.raw("COUNT(*) AS ??", ["TotalCount"]),
        this.read.raw("SUM(?? = 1) AS ??", ["IsActive", "ActiveCount"]),
        this.read.raw("SUM(?? = 0) AS ??", ["IsActive", "InactiveCount"]),
        hasMembers
          ? this.read.count("*").from("Vendors.VendorGroupMemberTbl").where({ OrgUID: orgUID, IsDeleted: 0 }).as("TotalMembers")
          : this.read.raw("0 AS ??", ["TotalMembers"])
      )
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getVendorGroupByUID
  async findByUID(orgUID: number, groupUID: number): Promise<Row | null> {
    const row = await this.read("Vendors.VendorGroupTbl as VG")
      .select(
        "VG.GroupUID as GroupUID",
        "VG.OrgUID as OrgUID",
        "VG.GroupCode as GroupCode",
        "VG.GroupName as GroupName",
        "VG.GroupType as GroupType",
        "VG.ContactPerson as ContactPerson",
        "VG.Mobile as Mobile",
        "VG.MobileCountryCode as MobileCountryCode",
        "VG.Email as Email",
        "VG.GSTNo as GSTNo",
        "VG.Address as Address",
        "VG.City as City",
        "VG.State as State",
        "VG.Country as Country",
        "VG.AddrLine1 as AddrLine1",
        "VG.AddrLine2 as AddrLine2",
        "VG.AddrCity as AddrCity",
        "VG.AddrState as AddrState",
        "VG.AddrStateCode as AddrStateCode",
        "VG.AddrPincode as AddrPincode",
        "VG.Notes as Notes",
        "VG.IsActive as IsActive",
        "VG.IsDeleted as IsDeleted",
        "VG.CreatedBy as CreatedBy",
        "VG.UpdatedBy as UpdatedBy",
        "VG.CreatedOn as CreatedOn",
        "VG.UpdatedOn as UpdatedOn"
      )
      .where({ "VG.OrgUID": orgUID, "VG.GroupUID": groupUID, "VG.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // getVendorGroupMembers — members with their closing balance, primary first.
  async findMembers(orgUID: number, groupUID: number, langCode: string): Promise<Row[]> {
    if (!(await this.hasMemberTable())) return [];
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Vendors.VendorGroupMemberTbl as VGM")
      .select(
        "V.VendorUID as VendorUID",
        this.langColumn(useLang, "VL.Name", "V.Name", "Name"),
        this.langColumn(useLang, "VL.Area", "V.Area", "Area"),
        "V.MobileNumber as MobileNumber",
        "VGM.IsGroupPrimary as IsGroupPrimary",
        this.read.raw("IFNULL(??, 0) AS ??", ["VOB.PendingBalance", "Balance"]),
        this.read.raw("IFNULL(??, 'Credit') AS ??", ["VOB.PendingBalType", "BalanceType"])
      )
      .join("Vendors.VendorTbl as V", (on) => {
        on.on("V.VendorUID", "VGM.VendorUID").andOnVal("V.IsDeleted", "=", 0);
      })
      .leftJoin("Vendors.VendOpeningBalanceTbl as VOB", (on) => {
        on.on("VOB.VendorUID", "V.VendorUID").andOn("VOB.OrgUID", "V.OrgUID").andOnVal("VOB.IsDeleted", "=", 0);
      })
      .where({ "VGM.OrgUID": orgUID, "VGM.GroupUID": groupUID, "VGM.IsDeleted": 0 })
      .orderBy([
        { column: "VGM.IsGroupPrimary", order: "desc" },
        { column: "V.Name", order: "asc" },
      ]);
    if (useLang) {
      query.leftJoin("Vendors.VendorTbl_Lang as VL", (on) => {
        on.on("VL.VendorUID", "V.VendorUID").andOnVal("VL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getVendorGroupOverview — member count and the group's combined receivable / payable.
  async overview(orgUID: number, groupUID: number): Promise<Row | null> {
    if (!(await this.hasMemberTable())) return null;
    const row = await this.read("Vendors.VendorGroupMemberTbl as VGM")
      .select(
        this.read.raw("COUNT(??) AS ??", ["VGM.VendorUID", "MemberCount"]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'Debit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", [
          "VOB.PendingBalType",
          "VOB.PendingBalance",
          "VOB.PendingBalance",
          "TotalReceivable",
        ]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'Credit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", [
          "VOB.PendingBalType",
          "VOB.PendingBalance",
          "VOB.PendingBalance",
          "TotalPayable",
        ])
      )
      .join("Vendors.VendorTbl as V", (on) => {
        on.on("V.VendorUID", "VGM.VendorUID").andOnVal("V.IsDeleted", "=", 0);
      })
      .leftJoin("Vendors.VendOpeningBalanceTbl as VOB", (on) => {
        on.on("VOB.VendorUID", "V.VendorUID").andOn("VOB.OrgUID", "V.OrgUID").andOnVal("VOB.IsDeleted", "=", 0);
      })
      .where({ "VGM.OrgUID": orgUID, "VGM.GroupUID": groupUID, "VGM.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // getActiveVendorGroupsForDropdown
  async findActiveForDropdown(orgUID: number, langCode: string): Promise<VendorGroupDropdownRow[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Vendors.VendorGroupTbl as vg")
      .select("vg.GroupUID as GroupUID", this.langColumn(useLang, "vgl.GroupName", "vg.GroupName", "GroupName"), "vg.GroupCode as GroupCode", "vg.GroupType as GroupType")
      .where({ "vg.OrgUID": orgUID, "vg.IsActive": 1, "vg.IsDeleted": 0 })
      .orderBy("vg.GroupName", "asc");
    if (useLang) {
      query.leftJoin("Vendors.VendorGroupTbl_Lang as vgl", (on) => {
        on.on("vgl.GroupUID", "vg.GroupUID").andOnVal("vgl.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // An active group as cached for the dropdown (CI3 upsertVendorGroup)
  async findActiveDropdownRow(orgUID: number, groupUID: number): Promise<VendorGroupDropdownRow | null> {
    const row = await this.read("Vendors.VendorGroupTbl")
      .select("GroupUID", "GroupName", "GroupCode", "GroupType")
      .where({ OrgUID: orgUID, GroupUID: groupUID, IsActive: 1, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getGroupTypes('vendors') — type names, or CI3's default list when none are configured.
  async findGroupTypes(): Promise<string[]> {
    const rows: { TypeName: string }[] = await this.read("Global.GroupTypesTbl")
      .select("TypeName")
      .where({ Module: "vendors", IsActive: 1 })
      .orderBy("SortOrder", "asc");
    return rows.length > 0 ? rows.map((row) => row.TypeName) : [...DEFAULT_GROUP_TYPES];
  }

  // searchVendorsForGroup — max 10 active vendors not already in a different group.
  async searchForGroup(orgUID: number, term: string, excludeGroupUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Vendors.VendorTbl as V")
      .select("V.VendorUID as VendorUID", this.langColumn(useLang, "VL.Name", "V.Name", "Name"), this.langColumn(useLang, "VL.Area", "V.Area", "Area"))
      .where({ "V.IsDeleted": 0, "V.IsActive": 1, "V.OrgUID": orgUID })
      .limit(10);
    this.whereAnyLike(query, TYPEAHEAD_SEARCH_COLUMNS, term);
    if (useLang) {
      query.leftJoin("Vendors.VendorTbl_Lang as VL", (on) => {
        on.on("VL.VendorUID", "V.VendorUID").andOnVal("VL.LangCode", "=", langCode);
      });
    }
    if (await this.hasMemberTable()) {
      query
        .leftJoin("Vendors.VendorGroupMemberTbl as VGM", (on) => {
          on.on("VGM.VendorUID", "V.VendorUID").andOn("VGM.OrgUID", "V.OrgUID").andOnVal("VGM.IsDeleted", "=", 0);
        })
        .where((group) => {
          group.whereNull("VGM.MemberUID");
          if (excludeGroupUID > 0) group.orWhere("VGM.GroupUID", excludeGroupUID);
        });
    }
    return query;
  }

  // getVendorGroupMembership — the vendor's group (profile overview)
  async findMembership(orgUID: number, vendorUID: number): Promise<Row | null> {
    if (!(await this.hasMemberTable())) return null;
    const row = await this.read("Vendors.VendorGroupMemberTbl")
      .select("MemberUID", "GroupUID", "IsGroupPrimary")
      .where({ OrgUID: orgUID, VendorUID: vendorUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async insertGroup(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number> {
    const [groupUID] = await trx("Vendors.VendorGroupTbl").insert(row);
    return groupUID;
  }

  async updateGroup(orgUID: number, groupUID: number, data: Record<string, unknown>, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)("Vendors.VendorGroupTbl").where({ GroupUID: groupUID, OrgUID: orgUID }).update(data);
  }

  // assignVendorGroupMembers — one membership per vendor, so this also moves vendors from another group.
  async assignMembers(trx: Knex.Transaction, orgUID: number, groupUID: number, memberUIDs: number[], primaryUID: number, userUID: number) {
    if (memberUIDs.length === 0) return;
    await this.requireMemberTable();
    for (const vendorUID of memberUIDs) {
      const isPrimary = vendorUID === primaryUID ? 1 : 0;
      await trx("Vendors.VendorGroupMemberTbl")
        .insert({ OrgUID: orgUID, VendorUID: vendorUID, GroupUID: groupUID, IsGroupPrimary: isPrimary, IsDeleted: 0, CreatedBy: userUID, UpdatedBy: userUID })
        .onConflict()
        .merge({ GroupUID: groupUID, IsGroupPrimary: isPrimary, IsDeleted: 0, UpdatedBy: userUID });
    }
  }

  // syncVendorGroupMembers — removes vendors no longer listed, then assigns the list.
  async syncMembers(trx: Knex.Transaction, orgUID: number, groupUID: number, memberUIDs: number[], primaryUID: number, userUID: number) {
    // Without the member table there is nothing to remove; members to add still need it
    if (memberUIDs.length === 0 && !(await this.hasMemberTable())) return;
    await this.requireMemberTable();
    const removed = trx("Vendors.VendorGroupMemberTbl").where({ OrgUID: orgUID, GroupUID: groupUID, IsDeleted: 0 });
    if (memberUIDs.length > 0) removed.whereNotIn("VendorUID", memberUIDs);
    await removed.update({ IsDeleted: 1, UpdatedBy: userUID });
    await this.assignMembers(trx, orgUID, groupUID, memberUIDs, primaryUID, userUID);
  }

  // unlinkAllVendorGroupMembers — before a group is deleted (nothing to unlink without the member table)
  async unlinkAllMembers(trx: Knex.Transaction, orgUID: number, groupUID: number, userUID: number) {
    if (!(await this.hasMemberTable())) return;
    await trx("Vendors.VendorGroupMemberTbl").where({ OrgUID: orgUID, GroupUID: groupUID, IsDeleted: 0 }).update({ IsDeleted: 1, UpdatedBy: userUID });
  }

  // saveVendorGroupLangRow — translated group text (one row per group and language).
  async saveLangRow(groupUID: number, langCode: string, text: Record<string, string | null>, userUID: number): Promise<void> {
    await this.writer()("Vendors.VendorGroupTbl_Lang")
      .insert({ GroupUID: groupUID, LangCode: langCode, ...text, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["GroupUID", "LangCode"])
      .merge([...Object.keys(text), "UpdatedBy"]);
  }

  // Members cannot be stored without Vendors.VendorGroupMemberTbl; CI3 fails with this database message
  private async requireMemberTable(): Promise<void> {
    if (!(await this.hasMemberTable())) throw new CiValidationError(`Table 'Vendors.${MEMBER_TABLE}' doesn't exist`);
  }

  // Shared by the count and the data query, so both always use the same conditions.
  private applyListFilters(query: Knex.QueryBuilder, orgUID: number, filter: VendorGroupListFilterDto, hasMembers: boolean): Knex.QueryBuilder {
    query.where({ "VG.OrgUID": orgUID, "VG.IsDeleted": 0 });
    if (filter.SearchAllData) this.whereAnyLike(query, GROUP_SEARCH_COLUMNS, filter.SearchAllData);
    if (filter.IsActive !== undefined) query.where("VG.IsActive", filter.IsActive);
    if (filter.GroupType?.length) query.whereIn("VG.GroupType", filter.GroupType);
    if (hasMembers && filter.VendorUID) {
      const vendorUID = filter.VendorUID;
      query.whereIn("VG.GroupUID", (sub) => {
        sub.select("GroupUID").from("Vendors.VendorGroupMemberTbl").where({ VendorUID: vendorUID, OrgUID: orgUID, IsDeleted: 0 });
      });
    }
    return query;
  }

  // Receivable / payable per group, only for the groups on this page (one query).
  private async attachBalanceTotals(orgUID: number, rows: Row[], hasMembers: boolean): Promise<void> {
    for (const row of rows) {
      row.TotalReceivable = "0";
      row.TotalPayable = "0";
    }
    if (!hasMembers || rows.length === 0) return;

    const totals: Row[] = await this.read("Vendors.VendorGroupMemberTbl as VGM")
      .select(
        "VGM.GroupUID as GroupUID",
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'Debit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", [
          "VOB.PendingBalType",
          "VOB.PendingBalance",
          "VOB.PendingBalance",
          "TotalReceivable",
        ]),
        this.read.raw("COALESCE(SUM(CASE WHEN ?? = 'Credit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", [
          "VOB.PendingBalType",
          "VOB.PendingBalance",
          "VOB.PendingBalance",
          "TotalPayable",
        ])
      )
      .join("Vendors.VendorTbl as V", (on) => {
        on.on("V.VendorUID", "VGM.VendorUID").andOnVal("V.IsDeleted", "=", 0);
      })
      .join("Vendors.VendOpeningBalanceTbl as VOB", (on) => {
        on.on("VOB.VendorUID", "V.VendorUID").andOn("VOB.OrgUID", "V.OrgUID").andOnVal("VOB.IsDeleted", "=", 0);
      })
      .where({ "VGM.OrgUID": orgUID, "VGM.IsDeleted": 0 })
      .whereIn(
        "VGM.GroupUID",
        rows.map((row) => toInt(row.GroupUID))
      )
      .groupBy("VGM.GroupUID");

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
