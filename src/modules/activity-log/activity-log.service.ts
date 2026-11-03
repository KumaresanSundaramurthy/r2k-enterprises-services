import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { buildDateRange } from "../../core/utils/date-range";
import { ActivityLogRepository, AuditFilter } from "./activity-log.repository";

// Preference key of the page's saved date filter (CI3 getDateFilterPreference('settings_activitylog'))
const DATE_PREFERENCE = "df_settings_activitylog";
// Entries shown in a record's history (CI3 getEntityHistory limit)
const HISTORY_LIMIT = 50;

// Settings → Activity Logs (CI3 Activitylog controller): the organisation's audit trail.
@Injectable()
export class ActivityLogService {
  constructor(
    private readonly repo: ActivityLogRepository,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // index — filter dropdowns and the user's saved date range (default this month)
  async getPageData(orgUID: number, branchUID: number, userUID: number) {
    const [settings, saved, modules, users] = await Promise.all([
      this.orgSettings.get(orgUID),
      this.repo.preference(orgUID, branchUID, userUID, DATE_PREFERENCE),
      this.repo.modules(orgUID),
      this.repo.users(orgUID),
    ]);
    const range = buildDateRange(saved || "this_month", settings.Timezone);
    return {
      Modules: modules,
      OrgUsers: users,
      SavedDateRange: range.range,
      SavedDateLabel: range.label,
      SavedDateFrom: range.from,
      SavedDateTo: range.to,
      InitFilter: { DateFrom: range.from, DateTo: range.to },
    };
  }

  // getPageDetails — the CI3 JS builds the rows
  async getPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: AuditFilter) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const [rows, total] = await Promise.all([this.repo.logs(orgUID, filter, limit, (pageNo - 1) * limit), this.repo.count(orgUID, filter)]);
    return { Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: limit };
  }

  // getEntityHistory — one record's timeline
  async getEntityHistory(orgUID: number, entityType: string, entityUID: number) {
    if (!entityType || !entityUID) throw new CiValidationError("Invalid parameters.");
    return { History: await this.repo.entityHistory(orgUID, entityType, entityUID, HISTORY_LIMIT) };
  }
}
