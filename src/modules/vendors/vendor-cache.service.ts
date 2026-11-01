import { Injectable, Logger } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { CacheHelperService } from "../../libraries/cache-helper/cache-helper.service";
import { VendorsRepository } from "./vendors.repository";

// PHP date('c'), e.g. 2026-10-26T09:15:00+00:00
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

// Vendors whose entries are built at the same time during a full sync (each entry runs 4 queries)
const SYNC_BATCH_SIZE = 5;

/**
 * Keeps the Upstash vendor map up to date (CI3 Cachehelper::upsertVendor / removeVendor and
 * Vendors::syncVendorsCache). Entries have the shape the CI3 purchase forms read.
 * Single-vendor refreshes never fail a save; a full sync reports its errors.
 */
@Injectable()
export class VendorCacheService {
  private readonly logger = new Logger(VendorCacheService.name);

  constructor(
    private readonly vendors: VendorsRepository,
    private readonly cacheHelper: CacheHelperService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  async refresh(orgUID: number, vendorUID: number): Promise<void> {
    try {
      const org = await this.orgSettings.get(orgUID);
      const entry = await this.buildEntry(orgUID, vendorUID);
      if (entry) await this.cacheHelper.writeVendorEntry(org.OrgToken, vendorUID, entry);
    } catch (err) {
      this.logger.warn(`Vendor cache refresh for ${vendorUID} failed: ${(err as Error).message}`);
    }
  }

  // syncVendorsCache — rebuilds {org}-vendors from every active vendor of the organisation
  async syncAll(orgUID: number) {
    const org = await this.orgSettings.get(orgUID);
    const vendorUIDs = await this.vendors.findActiveUIDs(orgUID);
    if (vendorUIDs.length === 0) throw new CiValidationError("No vendors found.");

    const entries = new Map<number, Record<string, unknown>>();
    for (let i = 0; i < vendorUIDs.length; i += SYNC_BATCH_SIZE) {
      const batch = vendorUIDs.slice(i, i + SYNC_BATCH_SIZE);
      const built = await Promise.all(batch.map((uid) => this.buildEntry(orgUID, uid)));
      batch.forEach((uid, index) => {
        const entry = built[index];
        if (entry) entries.set(uid, entry);
      });
    }
    await this.cacheHelper.replaceVendors(org.OrgToken, entries);
    return { Message: `${entries.size} vendor(s) synced to cache.`, Count: entries.size };
  }

  async remove(orgUID: number, vendorUID: number): Promise<void> {
    try {
      const org = await this.orgSettings.get(orgUID);
      await this.cacheHelper.removeVendorEntry(org.OrgToken, vendorUID);
    } catch (err) {
      this.logger.warn(`Vendor cache remove for ${vendorUID} failed: ${(err as Error).message}`);
    }
  }

  // vendor:{id}:products — CI3 drops it after a vendor update
  async removeProducts(vendorUID: number): Promise<void> {
    try {
      await this.cacheHelper.removeVendorProducts(vendorUID);
    } catch (err) {
      this.logger.warn(`Vendor products cache remove for ${vendorUID} failed: ${(err as Error).message}`);
    }
  }

  // One vendor's cache entry; null when the vendor is not found
  private async buildEntry(orgUID: number, vendorUID: number): Promise<Record<string, unknown> | null> {
    const vendor = await this.vendors.findDetail(orgUID, vendorUID, "en");
    if (!vendor) return null;

    const [addresses, opening] = await Promise.all([this.vendors.findAddresses(vendorUID, "en"), this.vendors.findOpeningBalance(orgUID, vendorUID)]);
    // PendingBalance is the running balance; the ledger balance is used only when there is no balance row yet
    const closing = opening
      ? { balance: Number(opening.PendingBalance ?? 0), type: opening.PendingBalType }
      : await this.vendors.findLedgerBalance(vendorUID);

    return {
      VendorUID: vendorUID,
      Name: vendor.Name ?? "",
      CompanyName: vendor.CompanyName ?? "",
      ContactPerson: vendor.ContactPerson ?? "",
      MobileNumber: vendor.MobileNumber ?? "",
      CountryCode: vendor.CountryCode ?? "",
      CountryISO2: vendor.CountryISO2 ?? "",
      EmailAddress: vendor.EmailAddress ?? "",
      GSTIN: vendor.GSTIN ?? "",
      PANNumber: vendor.PANNumber ?? "",
      OpeningBalance: opening ? Number(opening.OpeningBalance ?? 0) : 0,
      OpeningBalType: opening ? opening.OpeningBalType : "Credit",
      ClosingBalance: closing.balance,
      ClosingBalType: closing.type,
      Area: vendor.Area ?? "",
      Notes: vendor.Notes ?? "",
      Image: vendor.Image ?? "",
      Address: addresses.map((address) => ({
        AddressType: address.AddressType,
        Line1: address.Line1 ?? "",
        Line2: address.Line2 ?? "",
        Pincode: address.Pincode ?? "",
        CityText: address.CityText ?? "",
        State: address.State ?? "",
        StateText: address.StateText ?? "",
      })),
      LastUpdatedAt: isoNow(),
    };
  }
}
