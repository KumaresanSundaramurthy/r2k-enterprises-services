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
import { CustomerCacheService } from "./customer-cache.service";
import { CustomerGroupsRepository } from "./customer-groups.repository";
import { CustomerGroupsService } from "./customer-groups.service";
import { GroupFormDto, GroupIdDto, GroupStatusDto } from "./dto/customer-group.dto";

// Group text stored in English in CustomerGroupTbl and in Tamil in CustomerGroupTbl_Lang
const TEXT_FIELDS = {
  GroupName: "GroupName",
  ContactPerson: "ContactPerson",
  Notes: "Notes",
  AddrLine1: "AddrLine1",
  AddrLine2: "AddrLine2",
  AddrCity: "AddrCity",
  AddrState: "AddrState",
} as const;
type GroupTextField = keyof typeof TEXT_FIELDS;

/** Customer group create / update / delete / status (CI3 Customers controller group write actions). */
@Injectable()
export class CustomerGroupWriteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly groups: CustomerGroupsRepository,
    private readonly groupsRead: CustomerGroupsService,
    private readonly orgSettings: OrgSettingsService,
    private readonly translation: TranslationService,
    private readonly background: BackgroundTaskService,
    private readonly cacheHelper: CacheHelperService,
    private readonly customerCache: CustomerCacheService,
    private readonly audit: AuditLogService
  ) {}

  // addGroupData — the group and its members in one transaction; Tamil text, caches and audit afterwards.
  async create(form: GroupFormDto, ctx: WriteContext) {
    const { row, typed } = await this.buildRow(form, ctx);
    const memberUIDs = postIntList(form, "MemberUIDs");
    const primaryUID = postInt(form, "PrimaryUID");

    const groupUID = await this.db.transaction(async (trx) => {
      const uid = await this.groups.insertGroup(trx, { ...row, OrgUID: ctx.orgUID, IsActive: 1, CreatedBy: ctx.userUID });
      if (memberUIDs.length > 0) await this.groups.assignMembers(trx, ctx.orgUID, uid, memberUIDs, primaryUID, ctx.userUID);
      return uid;
    });

    await this.afterSave(ctx, groupUID, typed, memberUIDs);
    await this.audit.log(ctx, {
      action: "CREATE_CUSTOMER_GROUP",
      entityType: "CustomerGroup",
      entityUID: groupUID,
      entityRef: String(row.GroupName),
      summary: `Created customer group ${row.GroupName}`,
      module: "Customers",
      category: "MASTER",
      newValues: row,
    });
    return { Message: "Customer Group created successfully.", GroupUID: groupUID, GroupName: row.GroupName };
  }

  // updateGroupData — group fields and the member list (members not listed are removed).
  async update(form: GroupFormDto, ctx: WriteContext) {
    const groupUID = postInt(form, "GroupUID");
    if (!groupUID) throw new CiValidationError("Group ID is missing.");
    const { row, typed } = await this.buildRow(form, ctx);
    const before = await this.groups.findByUID(ctx.orgUID, groupUID);
    if (!before) throw new CiValidationError("Group not found.");
    const previousMembers = await this.groups.findMemberUIDs(ctx.orgUID, groupUID);
    const memberUIDs = postIntList(form, "MemberUIDs");

    await this.db.transaction(async (trx) => {
      await this.groups.updateGroup(ctx.orgUID, groupUID, row, trx);
      await this.groups.syncMembers(trx, ctx.orgUID, groupUID, memberUIDs, postInt(form, "PrimaryUID"), ctx.userUID);
    });

    // Removed members' cache entries change too (their GroupUID is cleared)
    await this.afterSave(ctx, groupUID, typed, [...new Set([...previousMembers, ...memberUIDs])]);
    await this.audit.log(ctx, {
      action: "UPDATE_CUSTOMER_GROUP",
      entityType: "CustomerGroup",
      entityUID: groupUID,
      entityRef: String(row.GroupName),
      summary: `Updated customer group ${row.GroupName}`,
      module: "Customers",
      category: "MASTER",
      oldValues: before,
      newValues: row,
    });
    return { Message: "Customer Group updated successfully.", GroupUID: groupUID, GroupName: row.GroupName };
  }

  // deleteGroup — unlinks every member, soft-deletes the group, returns the refreshed groups page.
  async delete(dto: GroupIdDto, ctx: WriteContext) {
    const groupUID = postInt(dto, "GroupUID");
    if (!groupUID) throw new CiValidationError("Group ID is missing.");
    const before = await this.groups.findByUID(ctx.orgUID, groupUID);
    if (!before) throw new CiValidationError("Group not found.");
    const members = await this.groups.findMemberUIDs(ctx.orgUID, groupUID);

    await this.db.transaction(async (trx) => {
      await this.groups.syncMembers(trx, ctx.orgUID, groupUID, [], 0, ctx.userUID);
      await this.groups.updateGroup(ctx.orgUID, groupUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID }, trx);
    });

    const org = await this.orgSettings.get(ctx.orgUID);
    await this.cacheHelper.removeCustomerGroupEntry(org.OrgToken, groupUID);
    for (const customerUID of members) await this.customerCache.refresh(ctx.orgUID, org.OrgToken, customerUID);
    await this.audit.log(ctx, {
      action: "DELETE_CUSTOMER_GROUP",
      entityType: "CustomerGroup",
      entityUID: groupUID,
      entityRef: before.GroupName ?? "",
      summary: `Deleted customer group #${groupUID}`,
      module: "Customers",
      category: "MASTER",
      oldValues: before,
    });
    return { Message: "Group deleted successfully.", ...(await this.pageAfterChange(dto, ctx.orgUID)) };
  }

  // toggleGroupStatus — an inactive group is removed from the dropdown cache.
  async setStatus(dto: GroupStatusDto, ctx: WriteContext) {
    const groupUID = postInt(dto, "GroupUID");
    const isActive = postInt(dto, "IsActive");
    if (!groupUID) throw new CiValidationError("Group ID is missing.");
    if (isActive !== 0 && isActive !== 1) throw new CiValidationError("Invalid status value.");

    const updated = await this.groups.updateGroup(ctx.orgUID, groupUID, { IsActive: isActive, UpdatedBy: ctx.userUID });
    if (updated === 0) throw new CiValidationError("Group not found.");

    const org = await this.orgSettings.get(ctx.orgUID);
    if (isActive === 1) await this.refreshGroupCache(ctx.orgUID, org.OrgToken, groupUID);
    else await this.cacheHelper.removeCustomerGroupEntry(org.OrgToken, groupUID);

    await this.audit.log(ctx, {
      action: "TOGGLE_CUSTOMER_GROUP_STATUS",
      entityType: "CustomerGroup",
      entityUID: groupUID,
      details: { isActive },
      summary: `${isActive ? "Activated" : "Deactivated"} customer group #${groupUID}`,
      module: "Customers",
      category: "MASTER",
      oldValues: { IsActive: 1 - isActive },
      newValues: { IsActive: isActive },
    });
    return { Message: "Status updated successfully.", ...(await this.pageAfterChange(dto, ctx.orgUID)) };
  }

  // CustomerGroupTbl row from the form; Tamil text fields are stored in English (each field detected on its own).
  private async buildRow(form: GroupFormDto, ctx: WriteContext) {
    const trimmed = (key: string) => String(postValue(form, key, "") ?? "").trim();
    if (!trimmed("GroupName")) throw new CiValidationError("Group Name is required.");

    const typed = {} as Record<GroupTextField, TypedText>;
    const english = {} as Record<GroupTextField, string | null>;
    for (const field of Object.keys(TEXT_FIELDS) as GroupTextField[]) {
      const result = await this.translation.normalize(trimmed(field));
      typed[field] = result.typed;
      english[field] = result.english;
    }

    const validTypes = await this.groups.findGroupTypes("customers");
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
      GSTINValidated: postInt(form, "GSTINValidated"),
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

  // After commit: Tamil row (background), group dropdown cache and the members' customer cache entries.
  private async afterSave(ctx: WriteContext, groupUID: number, typed: Record<GroupTextField, TypedText>, memberUIDs: number[]) {
    this.background.run(`Tamil text for customer group ${groupUID}`, async () => {
      const tamil: Record<string, string | null> = {};
      for (const field of Object.keys(TEXT_FIELDS) as GroupTextField[]) tamil[field] = await this.translation.typedToTamil(typed[field]);
      await this.groups.saveLangRow(groupUID, "ta", tamil, ctx.userUID);
    });

    const org = await this.orgSettings.get(ctx.orgUID);
    await this.refreshGroupCache(ctx.orgUID, org.OrgToken, groupUID);
    for (const customerUID of memberUIDs) await this.customerCache.refresh(ctx.orgUID, org.OrgToken, customerUID);
  }

  // upsertCustomerGroup — only active groups are cached
  private async refreshGroupCache(orgUID: number, orgToken: string, groupUID: number) {
    const group = await this.groups.findActiveDropdownRow(orgUID, groupUID);
    if (group) await this.cacheHelper.writeCustomerGroupEntry(orgToken, group);
  }

  // The groups page shown after delete / status change (CI3 returned it rendered; here as data)
  private async pageAfterChange(dto: GroupIdDto, orgUID: number) {
    const pageNo = postInt(dto, "PageNo") || 1;
    const { Data, TotalCount, PageNo, RowLimit, Stats } = await this.groupsRead.getPage(orgUID, pageNo, { langCode: "en" });
    return { Data, TotalCount, PageNo, RowLimit, Stats };
  }
}
