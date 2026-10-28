import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { CacheHelperService } from "../../libraries/cache-helper/cache-helper.service";
import { GroupListDto } from "./dto/customer-group.dto";
import { CustomerGroupsRepository } from "./customer-groups.repository";

const GROUP_TYPE_MODULE = "customers";

// Customer group rules from CI3's Customers controller (group section).
@Injectable()
export class CustomerGroupsService {
  constructor(
    private readonly groups: CustomerGroupsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly cacheHelper: CacheHelperService
  ) {}

  // getGroupsData — one page of groups plus the groups tab counters.
  async getPage(orgUID: number, pageNo: number, dto: GroupListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const page = Math.max(1, pageNo);
    const [result, stats] = await Promise.all([
      this.groups.listPaginated(orgUID, page, rowLimit, dto.Filter ?? {}, dto.langCode),
      this.groups.stats(orgUID),
    ]);
    return { Data: result.rows, TotalCount: result.totalCount, PageNo: page, RowLimit: rowLimit, Stats: stats };
  }

  // getGroupForModal — group, its members and the type list for the edit form.
  async getForModal(orgUID: number, groupUID: number, langCode: string) {
    const group = await this.requireGroup(orgUID, groupUID);
    const [members, groupTypes] = await Promise.all([
      this.groups.findMembersWithBalance(orgUID, groupUID, langCode),
      this.groups.findGroupTypes(GROUP_TYPE_MODULE),
    ]);
    return { Data: group, Members: members, GroupTypes: groupTypes };
  }

  // getGroupDetail — group, its members and the combined overview.
  async getDetail(orgUID: number, groupUID: number, langCode: string) {
    const group = await this.requireGroup(orgUID, groupUID);
    const [members, overview] = await Promise.all([
      this.groups.findMembersWithBalance(orgUID, groupUID, langCode),
      this.groups.overview(orgUID, groupUID),
    ]);
    return { Data: group, Members: members, Overview: overview };
  }

  // getGroupOutstanding — each member's closing balance.
  async getOutstanding(orgUID: number, groupUID: number, langCode: string) {
    return { Data: await this.groups.findMembersWithBalance(orgUID, groupUID, langCode) };
  }

  // getGroupsForDropdown — active groups; also refreshes the Upstash hash the CI3 forms read.
  async getForDropdown(orgUID: number, langCode: string) {
    const rows = await this.groups.findActiveForDropdown(orgUID, langCode);
    if (rows.length > 0) {
      const org = await this.orgSettings.get(orgUID);
      await this.cacheHelper.replaceCustomerGroups(org.OrgToken, rows);
    }
    return { Groups: rows };
  }

  // syncCustomerGroupsCache — rebuilds {org}-customer-groups from the active groups
  async syncCache(orgUID: number, langCode: string) {
    const rows = await this.groups.findActiveForDropdown(orgUID, langCode);
    if (rows.length === 0) throw new CiValidationError("No active customer groups found.");
    const org = await this.orgSettings.get(orgUID);
    await this.cacheHelper.replaceCustomerGroups(org.OrgToken, rows);
    return { Message: `${rows.length} group(s) synced to cache.`, Count: rows.length };
  }

  // getGroupTypes — also stored in the global Upstash key the CI3 forms read.
  async getGroupTypes() {
    const types = await this.groups.findGroupTypes(GROUP_TYPE_MODULE);
    await this.cacheHelper.storeCustomerGroupTypes(types);
    return { Data: types };
  }

  private async requireGroup(orgUID: number, groupUID: number) {
    if (!Number.isInteger(groupUID) || groupUID <= 0) {
      throw new CiValidationError("Group ID is missing.");
    }
    const group = await this.groups.findByUID(orgUID, groupUID);
    if (!group) {
      throw new CiValidationError("Group not found.");
    }
    return group;
  }
}
