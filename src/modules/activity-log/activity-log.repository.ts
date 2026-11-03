import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

// Filter of the audit list (CI3 Activitylog_model::_applyBaseQuery); dates are YYYY-MM-DD
export interface AuditFilter {
  DateFrom?: string;
  DateTo?: string;
  Module?: string;
  Action?: string;
  UserUID?: string | number;
  EntityType?: string;
  Search?: string;
}

const AUDIT = "Security.UserAuditLogTbl";

// CI3 Activitylog_model (+ the user's saved date filter, Userpreferences_model).
@Injectable()
export class ActivityLogRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getAuditLogs — newest first
  async logs(orgUID: number, filter: AuditFilter, limit: number, offset: number): Promise<Row[]> {
    return this.base(orgUID, filter)
      .select(
        "al.AuditUID", "al.UserUID", "al.UserName", "al.Action", "al.EntityType", "al.Module",
        "al.AuditCategory", "al.Result", "al.Source", "al.EntityUID", "al.EntityRef", "al.Summary",
        "al.IPAddress", "al.DeviceType", "al.Details", "al.CreatedOn"
      )
      .orderBy("al.AuditUID", "desc")
      .limit(limit)
      .offset(offset);
  }

  async count(orgUID: number, filter: AuditFilter): Promise<number> {
    const row = await this.base(orgUID, filter).count({ total: "*" }).first();
    return Number(row?.total ?? 0);
  }

  // getEntityHistory — one record's timeline
  async entityHistory(orgUID: number, entityType: string, entityUID: number, limit: number): Promise<Row[]> {
    return this.read(`${AUDIT} as al`)
      .select("al.AuditUID", "al.UserName", "al.Action", "al.EntityRef", "al.Summary", "al.Details", "al.IPAddress", "al.CreatedOn")
      .where({ "al.OrgUID": orgUID, "al.EntityType": entityType, "al.EntityUID": entityUID })
      .orderBy("al.AuditUID", "desc")
      .limit(limit);
  }

  // getDistinctModules — for the module filter
  async modules(orgUID: number): Promise<string[]> {
    const rows: Row[] = await this.read(`${AUDIT} as al`)
      .distinct("al.Module")
      .where("al.OrgUID", orgUID)
      .whereNotNull("al.Module")
      .whereNot("al.Module", "")
      .orderBy("al.Module", "asc");
    return rows.map((row) => String(row.Module));
  }

  // getDistinctUsers — for the user filter
  async users(orgUID: number): Promise<Row[]> {
    return this.read(`${AUDIT} as al`)
      .distinct("al.UserUID", "al.UserName")
      .where("al.OrgUID", orgUID)
      .whereNotNull("al.UserUID")
      .whereNot("al.UserUID", 0)
      .orderBy("al.UserName", "asc");
  }

  // Userpreferences_model::getUserPreference
  async preference(orgUID: number, branchUID: number, userUID: number, key: string): Promise<string | null> {
    const row = await this.read("Users.UserPreferencesTbl")
      .select("PreferenceValue")
      .where({ OrgUID: orgUID, BranchUID: branchUID, UserUID: userUID, PreferenceKey: key })
      .first();
    return row?.PreferenceValue ?? null;
  }

  private base(orgUID: number, filter: AuditFilter): Knex.QueryBuilder {
    const qb = this.read(`${AUDIT} as al`).where("al.OrgUID", orgUID);
    if (filter.DateFrom) qb.whereRaw("DATE(al.CreatedOn) >= ?", [filter.DateFrom]);
    if (filter.DateTo) qb.whereRaw("DATE(al.CreatedOn) <= ?", [filter.DateTo]);
    if (filter.Module) qb.where("al.Module", filter.Module);
    if (filter.Action) qb.where("al.Action", filter.Action);
    if (Number(filter.UserUID) > 0) qb.where("al.UserUID", Number(filter.UserUID));
    if (filter.EntityType) qb.where("al.EntityType", filter.EntityType);
    if (filter.Search) this.whereAnyLike(qb, ["al.EntityRef", "al.Summary", "al.UserName", "al.Action"], filter.Search);
    return qb;
  }
}
