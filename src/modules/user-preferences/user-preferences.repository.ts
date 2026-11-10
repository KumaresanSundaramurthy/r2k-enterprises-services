import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

const PREFERENCES = "Users.UserPreferencesTbl";

@Injectable()
export class UserPreferencesRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // Userpreferences_model::getUserPreference — null when the user has not saved this key
  async find(orgUID: number, branchUID: number, userUID: number, key: string): Promise<string | null> {
    const row = await this.read(PREFERENCES)
      .select("PreferenceValue")
      .where({ OrgUID: orgUID, BranchUID: branchUID, UserUID: userUID, PreferenceKey: key })
      .first();
    return row?.PreferenceValue ?? null;
  }

  // Userpreferences_model::getAllUserPreferences — { PreferenceKey: PreferenceValue }
  async all(orgUID: number, branchUID: number, userUID: number): Promise<Record<string, string>> {
    const rows: { PreferenceKey: string; PreferenceValue: string }[] = await this.read(PREFERENCES)
      .select("PreferenceKey", "PreferenceValue")
      .where({ OrgUID: orgUID, BranchUID: branchUID, UserUID: userUID });
    return Object.fromEntries(rows.map((row) => [row.PreferenceKey, row.PreferenceValue]));
  }

  // Dbwrite_ext_model::upsertPreference — one row per org / branch / user / key (uq_user_pref)
  async upsert(orgUID: number, branchUID: number, userUID: number, key: string, value: string): Promise<void> {
    await this.writer()(PREFERENCES)
      .insert({ OrgUID: orgUID, BranchUID: branchUID, UserUID: userUID, PreferenceKey: key, PreferenceValue: value })
      .onConflict(["OrgUID", "BranchUID", "UserUID", "PreferenceKey"])
      .merge({ PreferenceValue: value, UpdatedAt: this.writer().fn.now() });
  }
}
