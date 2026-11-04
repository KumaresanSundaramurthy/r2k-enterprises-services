import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postValue } from "../../core/utils/form-values";
import { DatabaseService } from "../../core/database/database.service";
import { SERIAL_STATUSES, SerialFilter, SerialsRepository } from "./serials.repository";

type Form = Record<string, unknown>;

// Statuses a user may set by hand (Sold / Returned come from transactions)
const SETTABLE_STATUSES = ["Available", "Damaged"];

/** Inventory → Serial Numbers page (CI3 Inventory serial actions): serials of serial-tracked products. */
@Injectable()
export class SerialsService {
  constructor(
    private readonly repo: SerialsRepository,
    private readonly db: DatabaseService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // serialsPage — stats (when the organisation shows them) and the status tabs
  async getPageData(orgUID: number) {
    const [showStats, settings] = await Promise.all([this.showStats(orgUID), this.orgSettings.get(orgUID)]);
    return { ShowStats: showStats, Stats: showStats ? await this.repo.stats(orgUID) : null, Statuses: SERIAL_STATUSES, RowLimit: settings.RowLimit };
  }

  // getSerialsPageDetails — the CI3 JS builds the rows from Data
  async getPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: SerialFilter) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const [rows, total, showStats] = await Promise.all([this.repo.list(orgUID, filter, limit, (pageNo - 1) * limit), this.repo.count(orgUID, filter), this.showStats(orgUID)]);
    return { Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: limit, Stats: showStats ? await this.repo.stats(orgUID) : null };
  }

  // searchSerialProducts — for the Add Serial modal
  async searchProducts(orgUID: number, term: string) {
    return { Data: await this.repo.searchProducts(orgUID, term.trim()) };
  }

  // addSerial — a manual serial (opening stock / ad-hoc), unique per product
  async add(ctx: WriteContext, form: Form) {
    const productUID = postInt(form, "ProductUID");
    const serialNumber = String(postValue(form, "SerialNumber") ?? "").trim();
    const notes = String(postValue(form, "Notes") ?? "").trim();
    // The product must also be one of the organisation's (CI3 did not check)
    if (productUID <= 0 || !(await this.repo.productExists(ctx.orgUID, productUID))) throw new CiValidationError("Please select a product.");
    if (serialNumber === "") throw new CiValidationError("Serial number is required.");
    if (await this.repo.exists(ctx.orgUID, productUID, serialNumber)) {
      throw new CiValidationError(`Serial number “${serialNumber}” already exists for this product.`);
    }
    await this.repo.insert({
      OrgUID: ctx.orgUID,
      ProductUID: productUID,
      SerialNumber: serialNumber,
      Status: "Available",
      Notes: notes || null,
      IsDeleted: 0,
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
    });
    return { Message: "Serial number added successfully." };
  }

  // updateSerialStatus — mark Damaged or restore Available
  async updateStatus(ctx: WriteContext, form: Form) {
    const serialUID = postInt(form, "SerialUID");
    const status = String(postValue(form, "Status") ?? "").trim();
    if (!SETTABLE_STATUSES.includes(status)) throw new CiValidationError(`Invalid status. Allowed: ${SETTABLE_STATUSES.join(", ")}`);
    if (serialUID <= 0) throw new CiValidationError("SerialUID is required.");
    await this.repo.setStatus(ctx.orgUID, serialUID, status, ctx.userUID);
    return { Message: "Status updated." };
  }

  // GenSettings->ShowStats (default on)
  private async showStats(orgUID: number): Promise<boolean> {
    const row = await this.db.read("Settings.OrgSettingsTbl").select("ShowStats").where({ OrgUID: orgUID }).first();
    return Number(row?.ShowStats ?? 1) === 1;
  }
}
