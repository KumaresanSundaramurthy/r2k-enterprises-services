import { Injectable } from "@nestjs/common";
import { BackgroundTaskService } from "../../core/background/background-task.service";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postIntList, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { CacheHelperService } from "../../libraries/cache-helper/cache-helper.service";
import { TranslationService, TypedText } from "../../libraries/translation/translation.service";
import { VendorGroupFormDto, VendorGroupIdDto, VendorGroupStatusDto } from "./dto/vendor-group.dto";
import { VendorGroupsRepository } from "./vendor-groups.repository";
import { VendorGroupsService } from "./vendor-groups.service";

// Group text stored in English in VendorGroupTbl and in Tamil in VendorGroupTbl_Lang
const TEXT_FIELDS = ["GroupName", "ContactPerson", "Notes", "AddrLine1", "AddrLine2", "AddrCity", "AddrState"] as const;
type GroupTextField = (typeof TEXT_FIELDS)[number];

/** Vendor group create / update / delete / status (CI3 Vendors controller group write actions). */
@Injectable()
export class VendorGroupWriteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly groups: VendorGroupsRepository,
    private readonly groupsRead: VendorGroupsService,
    private readonly orgSettings: OrgSettingsService,
    private readonly translation: TranslationService,
    private readonly background: BackgroundTaskService,
    private readonly cacheHelper: CacheHelperService,
    private readonly audit: AuditLogService
  ) {}

  // addGroupData — the group and its members in one transaction; Tamil text, cache and audit afterwards.
  async create(form: VendorGroupFormDto, ctx: WriteContext) {
    const { row, typed } = await this.buildRow(form, ctx);
    const memberUIDs = postIntList(form, "MemberUIDs");

    const groupUID = await this.db.transaction(async (trx) => {
      const uid = await this.groups.insertGroup(trx, { ...row, OrgUID: ctx.orgUID, IsActive: 1, CreatedBy: ctx.userUID });
      await this.groups.assignMembers(trx, ctx.orgUID, uid, memberUIDs, postInt(form, "PrimaryUID"), ctx.userUID);
      return uid;
    });

    await this.afterSave(ctx, groupUID, typed);
    await this.audit.log(ctx, {
      action: "CREATE_VENDOR_GROUP",
      entityType: "VendorGroup",
      entityUID: groupUID,
      entityRef: String(row.GroupName),
      summary: `Created vendor group ${row.GroupName}`,
      module: "Vendors",
      category: "MASTER",
      newValues: row,
    });
    return { Message: "Vendor Group created successfully.", GroupUID: groupUID };
  }

  // updateGroupData — group fields and the member list (members not listed are removed).
  async update(form: VendorGroupFormDto, ctx: WriteContext) {
    const groupUID = postInt(form, "GroupUID");
    if (!groupUID) throw new CiValidationError("Group ID is missing.");
    const { row, typed } = await this.buildRow(form, ctx);
    const before = await this.groups.findByUID(ctx.orgUID, groupUID);
    if (!before) throw new CiValidationError("Group not found.");

    await this.db.transaction(async (trx) => {
      await this.groups.updateGroup(ctx.orgUID, groupUID, row, trx);
      await this.groups.syncMembers(trx, ctx.orgUID, groupUID, postIntList(form, "MemberUIDs"), postInt(form, "PrimaryUID"), ctx.userUID);
    });

    await this.afterSave(ctx, groupUID, typed);
    await this.audit.log(ctx, {
      action: "UPDATE_VENDOR_GROUP",
      entityType: "VendorGroup",
      entityUID: groupUID,
      entityRef: String(row.GroupName),
      summary: `Updated vendor group ${row.GroupName}`,
      module: "Vendors",
      category: "MASTER",
      oldValues: before,
      newValues: row,
    });
    return { Message: "Vendor Group updated successfully.", GroupUID: groupUID };
  }

  // deleteGroup — unlinks every member, soft-deletes the group, returns the refreshed groups page.
  async delete(dto: VendorGroupIdDto, ctx: WriteContext) {
    const groupUID = postInt(dto, "GroupUID");
    if (!groupUID) throw new CiValidationError("Group ID is missing.");
    const before = await this.groups.findByUID(ctx.orgUID, groupUID);
    if (!before) throw new CiValidationError("Group not found.");

    await this.db.transaction(async (trx) => {
      await this.groups.unlinkAllMembers(trx, ctx.orgUID, groupUID, ctx.userUID);
      await this.groups.updateGroup(ctx.orgUID, groupUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID }, trx);
    });

    const org = await this.orgSettings.get(ctx.orgUID);
    await this.cacheHelper.removeVendorGroupEntry(org.OrgToken, groupUID);
    await this.audit.log(ctx, {
      action: "DELETE_VENDOR_GROUP",
      entityType: "VendorGroup",
      entityUID: groupUID,
      entityRef: before.GroupName ?? "",
      summary: `Deleted vendor group #${groupUID}`,
      module: "Vendors",
      category: "MASTER",
      oldValues: before,
    });
    return { Message: "Group deleted successfully.", ...(await this.pageAfterChange(dto, ctx.orgUID)) };
  }

  // toggleGroupStatus — an inactive group is removed from the dropdown cache.
  async setStatus(dto: VendorGroupStatusDto, ctx: WriteContext) {
    const groupUID = postInt(dto, "GroupUID");
    const isActive = postInt(dto, "IsActive");
    if (!groupUID) throw new CiValidationError("Group ID is missing.");
    if (isActive !== 0 && isActive !== 1) throw new CiValidationError("Invalid status value.");

    const updated = await this.groups.updateGroup(ctx.orgUID, groupUID, { IsActive: isActive, UpdatedBy: ctx.userUID });
    if (updated === 0) throw new CiValidationError("Group not found.");

    const org = await this.orgSettings.get(ctx.orgUID);
    if (isActive === 1) await this.refreshGroupCache(ctx.orgUID, org.OrgToken, groupUID);
    else await this.cacheHelper.removeVendorGroupEntry(org.OrgToken, groupUID);

    await this.audit.log(ctx, {
      action: "TOGGLE_VENDOR_GROUP_STATUS",
      entityType: "VendorGroup",
      entityUID: groupUID,
      details: { isActive },
      summary: `${isActive ? "Activated" : "Deactivated"} vendor group #${groupUID}`,
      module: "Vendors",
      category: "MASTER",
      oldValues: { IsActive: 1 - isActive },
      newValues: { IsActive: isActive },
    });
    return { Message: "Status updated successfully.", ...(await this.pageAfterChange(dto, ctx.orgUID)) };
  }

  // VendorGroupTbl row from the form; Tamil text fields are stored in English (each field detected on its own).
  private async buildRow(form: VendorGroupFormDto, ctx: WriteContext) {
    const trimmed = (key: string) => String(postValue(form, key, "") ?? "").trim();
    if (!trimmed("GroupName")) throw new CiValidationError("Group Name is required.");

    const typed = {} as Record<GroupTextField, TypedText>;
    const english = {} as Record<GroupTextField, string | null>;
    for (const field of TEXT_FIELDS) {
      const result = await this.translation.normalize(trimmed(field));
      typed[field] = result.typed;
      english[field] = result.english;
    }

    const validTypes = await this.groups.findGroupTypes();
    const groupType = postString(form, "GroupType") ?? "";
    const row: Record<string, unknown> = {
      GroupCode: trimmed("GroupCode") || null,
      GroupName: english.GroupName,
      GroupType: validTypes.includes(groupType) ? groupType : "Business Group",
      ContactPerson: english.ContactPerson,
      Mobile: trimmed("Mobile") || null,
      MobileCountryCode: trimmed("MobileCountryCode") || null,
      Email: trimmed("Email") || null,
      GSTNo: trimmed("GSTIN").toUpperCase() || null,
      AddrLine1: english.AddrLine1,
      AddrLine2: english.AddrLine2,
      AddrCity: english.AddrCity,
      AddrState: english.AddrState,
      AddrStateCode: trimmed("AddrStateCode") || null,
      AddrPincode: trimmed("AddrPincode") || null,
      Notes: english.Notes,
      UpdatedBy: ctx.userUID,
    };
    return { row, typed };
  }

  // After commit: Tamil row (background) and the group dropdown cache.
  private async afterSave(ctx: WriteContext, groupUID: number, typed: Record<GroupTextField, TypedText>) {
    this.background.run(`Tamil text for vendor group ${groupUID}`, async () => {
      const tamil: Record<string, string | null> = {};
      for (const field of TEXT_FIELDS) tamil[field] = await this.translation.typedToTamil(typed[field]);
      await this.groups.saveLangRow(groupUID, "ta", tamil, ctx.userUID);
    });
    const org = await this.orgSettings.get(ctx.orgUID);
    await this.refreshGroupCache(ctx.orgUID, org.OrgToken, groupUID);
  }

  // upsertVendorGroup — only active groups are cached
  private async refreshGroupCache(orgUID: number, orgToken: string, groupUID: number) {
    const group = await this.groups.findActiveDropdownRow(orgUID, groupUID);
    if (group) await this.cacheHelper.writeVendorGroupEntry(orgToken, group);
  }

  // The groups page shown after delete / status change (CI3 returned it rendered; here as data)
  private async pageAfterChange(dto: VendorGroupIdDto, orgUID: number) {
    const pageNo = postInt(dto, "PageNo") || 1;
    const { Data, TotalCount, PageNo, RowLimit, Stats } = await this.groupsRead.getPage(orgUID, pageNo, { langCode: "en" });
    return { Data, TotalCount, PageNo, RowLimit, Stats };
  }
}
