import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettings } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { RedisService } from "../../common/redis/redis.service";
import { UpstashService } from "../../common/redis/upstash.service";
import { nowDateTime, toInt } from "../../common/utils/php-compat";
import { currentFinancialYear2, padYear2 } from "../../core/utils/financial-year";
import { CacheHelperService } from "../cache-helper/cache-helper.service";

export interface CreditSettingsRow {
  OrgUID: string;
  CustomerSeq: string;
  CustomerSeqYear: string;
  CustomerNextNumber: string | null;
  VendorSeq: string;
  VendorSeqYear: string;
  VendorNextNumber: string | null;
  GstinPoints: string | null;
}

// Shape CI3 stores in Upstash under {org}-credit-settings
interface CachedCreditSettings {
  cust_next_number?: string;
  gstin_points?: number;
}

/**
 * Per-organisation numbering for customers and vendors (Settings.OrgCreditSettingsTbl), with the
 * financial-year rollover rules from CI3's Customers_model / Vendors_model.
 */
@Injectable()
export class CreditSettingsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly upstash: UpstashService,
    private readonly cacheHelper: CacheHelperService
  ) {}

  /** Next customer number to show on the "new customer" form — Upstash first, then the database. */
  async getCustomerNextNumber(org: OrgSettings): Promise<string> {
    const cached = await this.upstash.get<CachedCreditSettings>(this.redis.orgKey("credit-settings", org.OrgToken));
    if (cached && cached.cust_next_number) {
      return cached.cust_next_number;
    }

    const settings = await this.getOrInit(org);
    if (!settings || !settings.CustomerNextNumber) {
      throw new CiValidationError("Unable to load credit settings.");
    }
    await this.cacheHelper.storeCreditSettings(org.OrgToken, settings.CustomerNextNumber, toInt(settings.GstinPoints));
    return settings.CustomerNextNumber;
  }

  /**
   * Atomically takes the next customer number (CI3 claimNextCustomerNumber) and refreshes the cache.
   * Optimistic lock on CustomerSeq + CustomerSeqYear, retried up to 5 times; a real FY rollover
   * (stored year = current − 1) restarts at 0001. Returns null when no number could be claimed.
   */
  async claimNextCustomerNumber(org: OrgSettings): Promise<{ claimed: string; next: string } | null> {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const row = await this.find(org.OrgUID);
      if (!row) return null;

      const currentYear = currentFinancialYear2(org.FYStartMonth, org.Timezone);
      const storedYear = toInt(row.CustomerSeqYear);
      const storedSeq = toInt(row.CustomerSeq);
      const isRollover = storedYear === (currentYear - 1 + 100) % 100;
      // Same year, or stale initialisation data: continue the existing sequence
      const claimedSeq = currentYear !== storedYear && isRollover ? 1 : storedSeq;
      const nextSeq = claimedSeq + 1;
      const yearPad = padYear2(currentYear);
      const claimed = `C-${yearPad}${String(claimedSeq).padStart(4, "0")}`;
      const next = `C-${yearPad}${String(nextSeq).padStart(4, "0")}`;

      const affected = await this.db
        .write("Settings.OrgCreditSettingsTbl")
        .where({ OrgUID: org.OrgUID, CustomerSeq: storedSeq, CustomerSeqYear: storedYear })
        .update({ CustomerSeq: nextSeq, CustomerSeqYear: currentYear, CustomerNextNumber: next, UpdatedAt: nowDateTime() });
      if (affected === 1) {
        await this.cacheHelper.storeCreditSettings(org.OrgToken, next, toInt(row.GstinPoints));
        return { claimed, next };
      }
    }
    return null;
  }

  /**
   * Returns the settings row for the current financial year (CI3 getOrInitCreditSettings):
   * creates it when missing, resets the customer sequence when the FY rolled over, and
   * backfills CustomerNextNumber on rows created before that column existed.
   */
  async getOrInit(org: OrgSettings): Promise<CreditSettingsRow | null> {
    const existing = await this.find(org.OrgUID);
    const fyYear2 = currentFinancialYear2(org.FYStartMonth, org.Timezone);
    const yearPad = padYear2(fyYear2);

    if (!existing) {
      await this.db.write("Settings.OrgCreditSettingsTbl").insert({
        OrgUID: org.OrgUID,
        CustomerSeq: 1,
        CustomerSeqYear: fyYear2,
        CustomerNextNumber: `C-${yearPad}0001`,
        VendorSeq: 1,
        VendorSeqYear: fyYear2,
        VendorNextNumber: `V-${yearPad}0001`,
        GstinPoints: 0,
      });
      return this.find(org.OrgUID);
    }

    if (toInt(existing.CustomerSeqYear) !== fyYear2) {
      // Optimistic WHERE on the old year: only one concurrent caller performs the reset
      await this.db
        .write("Settings.OrgCreditSettingsTbl")
        .where({ OrgUID: org.OrgUID, CustomerSeqYear: toInt(existing.CustomerSeqYear) })
        .update({ CustomerSeq: 1, CustomerSeqYear: fyYear2, CustomerNextNumber: `C-${yearPad}0001`, UpdatedAt: nowDateTime() });
      return this.find(org.OrgUID);
    }

    if (!existing.CustomerNextNumber) {
      await this.db
        .write("Settings.OrgCreditSettingsTbl")
        .where({ OrgUID: org.OrgUID })
        .update({
          CustomerNextNumber: `C-${yearPad}${String(toInt(existing.CustomerSeq)).padStart(4, "0")}`,
          CustomerSeqYear: fyYear2,
          UpdatedAt: nowDateTime(),
        });
      return this.find(org.OrgUID);
    }

    return existing;
  }

  async find(orgUID: number): Promise<CreditSettingsRow | null> {
    const row = await this.db
      .read("Settings.OrgCreditSettingsTbl")
      .select(
        "OrgUID",
        "CustomerSeq",
        "CustomerSeqYear",
        "CustomerNextNumber",
        "VendorSeq",
        "VendorSeqYear",
        "VendorNextNumber",
        "GstinPoints"
      )
      .where({ OrgUID: orgUID })
      .first();
    return row ?? null;
  }
}
