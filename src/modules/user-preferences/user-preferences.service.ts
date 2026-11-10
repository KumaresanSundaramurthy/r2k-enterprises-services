import { Injectable } from "@nestjs/common";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { UserPreferencesRepository } from "./user-preferences.repository";

// Date-filter keys and the module their change is logged under (anything else: "User Preferences")
const KEY_MODULE: Record<string, string> = {
  df_invoices: "Invoices",
  df_purchases: "Purchases",
  df_salesorders: "Sales Orders",
  df_quotations: "Quotations",
  df_deliverychallans: "Delivery Challans",
  df_purchasereturns: "Purchase Returns",
  df_salesreturns: "Sales Returns",
  df_proformainvoices: "Proforma Invoices",
  df_payments: "Payments",
  df_expenses: "Expenses",
  df_indirectincome: "Indirect Income",
  df_inventory: "Inventory",
  df_settings_activitylog: "Activity Log",
};

// CI3 Userpreferences controller + Userpreferences_model, per org / branch / user
@Injectable()
export class UserPreferencesService {
  constructor(
    private readonly repo: UserPreferencesRepository,
    private readonly auditLog: AuditLogService
  ) {}

  // save — upsert the key, then log it (UPDATE_PREFERENCE)
  async save(ctx: WriteContext, rawKey: unknown, rawValue: unknown) {
    const key = String(rawKey ?? "").trim();
    const value = String(rawValue ?? "").trim();
    if (!key) throw new CiValidationError("PreferenceKey is required");
    if (key.length > 100) throw new CiValidationError("PreferenceKey must be at most 100 characters");

    await this.repo.upsert(ctx.orgUID, ctx.branchUID ?? 0, ctx.userUID, key, value);
    await this.auditLog.log(ctx, {
      action: "UPDATE_PREFERENCE",
      entityType: "UserPreference",
      entityUID: ctx.userUID,
      entityRef: key,
      details: { PreferenceKey: key, PreferenceValue: value },
      summary: `User preference updated: ${key} = ${value}`,
      module: KEY_MODULE[key] ?? "User Preferences",
      category: "SETTINGS",
      result: "SUCCESS",
    });
    return {};
  }

  // getAll
  async getAll(orgUID: number, branchUID: number, userUID: number) {
    return { Preferences: await this.repo.all(orgUID, branchUID, userUID) };
  }

  // getUserPreference (MY_Controller::getDateFilterPreference reads 'df_<page>') — null when not saved
  async get(orgUID: number, branchUID: number, userUID: number, rawKey: unknown) {
    const key = String(rawKey ?? "").trim();
    if (!key) throw new CiValidationError("PreferenceKey is required");
    return { PreferenceValue: await this.repo.find(orgUID, branchUID, userUID, key) };
  }
}
