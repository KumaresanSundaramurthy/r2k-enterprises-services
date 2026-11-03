import { Injectable } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { UpstashService } from "../../common/redis/upstash.service";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postFlag, postInt, postValue } from "../../core/utils/form-values";
import { Row, SettingsLookupsRepository } from "./settings-lookups.repository";

const CHARGES = "Settings.AdditionalChargesTbl";
// CI3 CHARGE_LIMIT — used when TransSettings has no MaxAdditionalCharges
const DEFAULT_CHARGE_LIMIT = 5;
// Charges every organisation has; they can't be deleted and only their tax and description change
const SYSTEM_CHARGES = [
  { Name: "Delivery_Shipping", DisplayName: "Delivery / Shipping Charges", SortOrder: 1 },
  { Name: "Packaging", DisplayName: "Packaging Charges", SortOrder: 2 },
];

// Organisation_model additional-charge queries.
@Injectable()
export class AdditionalChargesRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getAdditionalChargesList — system charges first, then by sort order, with the default tax
  async list(orgUID: number): Promise<Row[]> {
    return this.read(`${CHARGES} as C`)
      .select(
        "C.ChargeUID", "C.Name", "C.DisplayName", "C.DefaultTaxUID",
        "C.Description", "C.ShowByDefault", "C.IsSystem", "C.SortOrder",
        "C.IsActive", "C.CreatedAt", "C.UpdatedAt",
        "T.TaxName as TaxName", "T.Percentage as TaxPercentage"
      )
      .leftJoin("Global.TaxDetailsTbl as T", (on) => {
        on.on("T.TaxDetailsUID", "C.DefaultTaxUID").andOnVal("T.IsDeleted", "=", 0);
      })
      .where({ "C.OrgUID": orgUID, "C.IsDeleted": 0 })
      .orderBy([
        { column: "C.IsSystem", order: "desc" },
        { column: "C.SortOrder", order: "asc" },
        { column: "C.ChargeUID", order: "asc" },
      ]);
  }

  async find(orgUID: number, chargeUID: number): Promise<Row | null> {
    const row = await this.read(CHARGES).select("*").where({ ChargeUID: chargeUID, OrgUID: orgUID, IsDeleted: 0 }).first();
    return row ?? null;
  }

  // getCustomChargesCount — every active charge (system included) counts towards the limit
  async count(orgUID: number): Promise<number> {
    const row = await this.read(CHARGES).count({ total: "*" }).where({ OrgUID: orgUID, IsDeleted: 0 }).first();
    return Number(row?.total ?? 0);
  }

  async nameExists(orgUID: number, name: string, excludeUID = 0): Promise<boolean> {
    const qb = this.read(CHARGES).select("ChargeUID").where({ OrgUID: orgUID, Name: name, IsDeleted: 0 });
    if (excludeUID > 0) qb.whereNot("ChargeUID", excludeUID);
    return !!(await qb.first());
  }

  // chargeIsUsedInAnyTransaction
  async isUsed(orgUID: number, chargeUID: number): Promise<boolean> {
    return !!(await this.read("Transaction.TransactionChargesTbl").select("TransChargeUID").where({ ChargeUID: chargeUID, OrgUID: orgUID, IsActive: 1 }).first());
  }

  async insert(data: Row): Promise<number> {
    const [id] = await this.db.write(CHARGES).insert(data);
    return Number(id);
  }

  async update(orgUID: number, where: Row, data: Row): Promise<void> {
    await this.db.write(CHARGES).where({ ...where, OrgUID: orgUID }).update(data);
  }
}

/**
 * Settings → Additional Charges (CI3 Settings additional-charge functions). Every change rewrites the
 * {org}-additional-charges Upstash list the transaction forms read.
 */
@Injectable()
export class AdditionalChargesService {
  constructor(
    private readonly repo: AdditionalChargesRepository,
    private readonly lookups: SettingsLookupsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly upstash: UpstashService
  ) {}

  // additionalcharges — makes sure the system charges exist, then the list and the tax dropdown
  async getPageData(ctx: { orgUID: number; userUID: number }) {
    await this.seedSystemCharges(ctx.orgUID, ctx.userUID);
    const [list, taxList] = await Promise.all([this.getList(ctx.orgUID), this.lookups.taxDetails()]);
    return { ...list, TaxList: taxList };
  }

  // getAdditionalChargesList — rows, how many there are, the limit and the next sort order
  async getList(orgUID: number) {
    const [rows, limit] = await Promise.all([this.repo.list(orgUID), this.chargeLimit(orgUID)]);
    return AdditionalChargesService.listResponse(rows, limit);
  }

  // getAdditionalChargesCache — the cached list (built on a miss), as the transaction forms read it
  async getCached(orgUID: number) {
    const key = await this.cacheKey(orgUID);
    const cached = await this.upstash.get<Row[]>(key);
    if (cached !== null) return { Data: Array.isArray(cached) ? cached : [] };
    const rows = await this.repo.list(orgUID);
    if (rows.length > 0) await this.upstash.set(key, rows, 0);
    return { Data: rows };
  }

  // saveAdditionalCharge
  async save(form: Record<string, unknown>, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    const chargeUID = postInt(form, "acChargeUID");
    const rawName = String(postValue(form, "acName") ?? "").trim();
    const displayName = String(postValue(form, "acDisplayName") ?? "").trim();
    const description = String(postValue(form, "acDescription") ?? "").trim() || null;
    const taxUID = postInt(form, "acDefaultTaxUID") || null;
    const showByDefault = postFlag(form, "acShowByDefault");
    const sortOrder = Math.max(0, postInt(form, "acSortOrder"));
    if (!displayName) throw new CiValidationError("Display name is required.");
    if ([...displayName].length > 150) throw new CiValidationError("Display name must not exceed 150 characters.");
    const limit = await this.chargeLimit(orgUID);

    let newUID = 0;
    let message: string;
    if (chargeUID > 0) {
      const existing = await this.repo.find(orgUID, chargeUID);
      if (!existing) throw new CiValidationError("Charge not found.");
      let data: Row;
      if (Number(existing.IsSystem) === 1) {
        data = { Description: description, DefaultTaxUID: taxUID, UpdatedBy: userUID };
      } else {
        const name = AdditionalChargesService.chargeName(rawName, displayName);
        if (await this.repo.nameExists(orgUID, name, chargeUID)) throw new CiValidationError("A charge with this name already exists.");
        data = { Name: name, DisplayName: displayName, DefaultTaxUID: taxUID, Description: description, ShowByDefault: showByDefault, SortOrder: sortOrder, UpdatedBy: userUID };
      }
      await this.repo.update(orgUID, { ChargeUID: chargeUID, IsDeleted: 0 }, data);
      message = "Charge updated successfully.";
    } else {
      if ((await this.repo.count(orgUID)) >= limit) {
        throw new CiValidationError(`You have reached the maximum of ${limit} charges. Delete one to add another.`);
      }
      const name = AdditionalChargesService.chargeName(rawName, displayName);
      if (await this.repo.nameExists(orgUID, name)) throw new CiValidationError("A charge with this name already exists.");
      newUID = await this.repo.insert({
        OrgUID: orgUID,
        Name: name,
        DisplayName: displayName,
        DefaultTaxUID: taxUID,
        Description: description,
        ShowByDefault: showByDefault,
        IsSystem: 0,
        SortOrder: sortOrder,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      message = "Charge added successfully.";
    }

    const rows = await this.refreshCache(orgUID);
    const newCharge = newUID ? rows.find((row) => Number(row.ChargeUID) === newUID) : undefined;
    return { Message: message, ...AdditionalChargesService.listResponse(rows, limit), AllCharges: rows, ...(newCharge ? { NewCharge: newCharge } : {}) };
  }

  // deleteAdditionalCharge — system charges and charges used in a transaction are kept
  async delete(chargeUID: number, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    if (chargeUID <= 0) throw new CiValidationError("Invalid charge ID.");
    const existing = await this.repo.find(orgUID, chargeUID);
    if (!existing) throw new CiValidationError("Charge not found.");
    if (Number(existing.IsSystem) === 1) throw new CiValidationError("System charges cannot be deleted.");
    if (await this.repo.isUsed(orgUID, chargeUID)) {
      throw new CiValidationError("This charge is used in one or more transactions and cannot be deleted. Remove it from all transactions first.");
    }
    await this.repo.update(orgUID, { ChargeUID: chargeUID }, { IsDeleted: 1, IsActive: 0, UpdatedBy: userUID });
    const rows = await this.refreshCache(orgUID);
    return { Message: "Charge deleted successfully.", ...AdditionalChargesService.listResponse(rows, await this.chargeLimit(orgUID)) };
  }

  // _seedSystemCharges
  private async seedSystemCharges(orgUID: number, userUID: number): Promise<void> {
    for (const charge of SYSTEM_CHARGES) {
      if (await this.repo.nameExists(orgUID, charge.Name)) continue;
      await this.repo.insert({
        OrgUID: orgUID,
        ...charge,
        DefaultTaxUID: null,
        Description: null,
        ShowByDefault: 1,
        IsSystem: 1,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
    }
  }

  // The fresh list, written to the Upstash cache
  private async refreshCache(orgUID: number): Promise<Row[]> {
    const rows = await this.repo.list(orgUID);
    await this.upstash.set(await this.cacheKey(orgUID), rows, 0);
    return rows;
  }

  private async cacheKey(orgUID: number): Promise<string> {
    return this.redis.orgKey("additional-charges", (await this.orgSettings.get(orgUID)).OrgToken);
  }

  // TransSettings->MaxAdditionalCharges
  private async chargeLimit(orgUID: number): Promise<number> {
    const row = await this.db.read("Settings.TransactionSettingsTbl").select("MaxAdditionalCharges").where({ OrgUID: orgUID }).first();
    return row?.MaxAdditionalCharges == null ? DEFAULT_CHARGE_LIMIT : Number(row.MaxAdditionalCharges);
  }

  // A posted name keeps letters, digits and "_"; otherwise the display name becomes the name
  private static chargeName(rawName: string, displayName: string): string {
    if (rawName) {
      const clean = rawName.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
      if (!clean) throw new CiValidationError("Name must contain at least one alphanumeric character.");
      return clean.slice(0, 100);
    }
    return displayName.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
  }

  private static listResponse(rows: Row[], limit: number) {
    const maxSort = rows.reduce((max, row) => Math.max(max, Number(row.SortOrder ?? 0)), 0);
    return { Data: rows, ChargeCount: rows.length, ChargeLimit: limit, NextSortOrder: maxSort + 1 };
  }
}
