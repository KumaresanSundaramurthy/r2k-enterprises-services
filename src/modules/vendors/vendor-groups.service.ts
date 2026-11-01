import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { CacheHelperService } from "../../libraries/cache-helper/cache-helper.service";
import { SearchVendorsDto } from "./dto/vendor-list.dto";
import { VendorGroupListDto } from "./dto/vendor-group.dto";
import { VendorGroupsRepository } from "./vendor-groups.repository";

// Vendor group reads from CI3's Vendors controller (group section).
@Injectable()
export class VendorGroupsService {
  constructor(
    private readonly groups: VendorGroupsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly cacheHelper: CacheHelperService
  ) {}

  // getGroupsData — one page of groups plus the groups tab counters.
  async getPage(orgUID: number, pageNo: number, dto: VendorGroupListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const page = Math.max(1, pageNo);
    const [result, stats] = await Promise.all([this.groups.listPaginated(orgUID, page, rowLimit, dto.Filter ?? {}, dto.langCode), this.groups.stats(orgUID)]);
    return { Data: result.rows, TotalCount: result.totalCount, PageNo: page, RowLimit: rowLimit, Stats: stats };
  }

  // getGroupForModal — group and its members for the edit form (group types come from getGroupTypes).
  async getForModal(orgUID: number, groupUID: number, langCode: string) {
    const group = await this.requireGroup(orgUID, groupUID);
    return { Data: group, Members: await this.groups.findMembers(orgUID, groupUID, langCode) };
  }

  // getGroupDetail — group, its members and the combined overview.
  async getDetail(orgUID: number, groupUID: number, langCode: string) {
    const group = await this.requireGroup(orgUID, groupUID);
    const [members, overview] = await Promise.all([this.groups.findMembers(orgUID, groupUID, langCode), this.groups.overview(orgUID, groupUID)]);
    return { Data: group, Members: members, Overview: overview };
  }

  // getGroupsForDropdown — active groups for the vendor form
  async getForDropdown(orgUID: number, langCode: string) {
    return { Groups: await this.groups.findActiveForDropdown(orgUID, langCode) };
  }

  // syncVendorGroupsCache — rebuilds {org}-vendor-groups from the active groups
  async syncCache(orgUID: number, langCode: string) {
    const rows = await this.groups.findActiveForDropdown(orgUID, langCode);
    if (rows.length === 0) throw new CiValidationError("No active vendor groups found.");
    const org = await this.orgSettings.get(orgUID);
    await this.cacheHelper.replaceVendorGroups(org.OrgToken, rows);
    return { Message: `${rows.length} group(s) synced to cache.`, Count: rows.length };
  }

  // getGroupTypes
  async getGroupTypes() {
    return { Data: await this.groups.findGroupTypes() };
  }

  // searchVendors — group form typeahead: { id, text } where text is "Name (Area)".
  async searchVendors(dto: SearchVendorsDto) {
    const term = (dto.term ?? "").trim();
    if (!term) return { Lists: [] };
    const rows = await this.groups.searchForGroup(dto.orgId, term, dto.groupUID, dto.langCode);
    return { Lists: rows.map((vendor) => ({ id: vendor.VendorUID, text: vendor.Area ? `${vendor.Name} (${vendor.Area})` : vendor.Name })) };
  }

  private async requireGroup(orgUID: number, groupUID: number) {
    if (!Number.isInteger(groupUID) || groupUID <= 0) throw new CiValidationError("Group ID is missing.");
    const group = await this.groups.findByUID(orgUID, groupUID);
    if (!group) throw new CiValidationError("Group not found.");
    return group;
  }
}
