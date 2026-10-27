import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service";
import { CiValidationError } from "../response/ci-response";
import { resolveCdnUrl, toInt } from "../../common/utils/php-compat";

export interface OrgSettings {
  OrgUID: number;
  OrgToken: string;
  // IANA timezone of the organisation (CI3's JwtData->User->Timezone comes from the same column)
  Timezone: string;
  // GenSettings->FYStartMonth, default 4 (April)
  FYStartMonth: number;
  // GenSettings->RowLimit, default 10
  RowLimit: number;
  // GenSettings->ListDateTimeFormat (PHP date format); null when the organisation has not set one
  ListDateTimeFormat: string | null;
}

/**
 * Organisation values CI3 reads from the logged-in session (JwtData). This API is stateless,
 * so they are loaded from the database by the orgId the caller sends.
 */
@Injectable()
export class OrgSettingsService {
  constructor(private readonly db: DatabaseService) {}

  async get(orgUID: number): Promise<OrgSettings> {
    const row = await this.db
      .read("Organisation.OrganisationTbl as Org")
      .select(
        "Org.OrgUID as OrgUID",
        "Org.OrgToken as OrgToken",
        "Tz.Timezone as Timezone",
        "Settg.FYStartMonth as FYStartMonth",
        "Settg.RowLimit as RowLimit",
        "Settg.ListDateTimeFormat as ListDateTimeFormat"
      )
      .leftJoin("Global.TimezoneTbl as Tz", "Tz.TimezoneUID", "Org.TimezoneUID")
      .leftJoin("Settings.OrgSettingsTbl as Settg", "Settg.OrgUID", "Org.OrgUID")
      .where({ "Org.OrgUID": orgUID, "Org.IsDeleted": 0 })
      .first();
    if (!row) {
      throw new CiValidationError("Organisation not found.");
    }
    return {
      OrgUID: toInt(row.OrgUID),
      OrgToken: row.OrgToken ?? "",
      Timezone: row.Timezone || "UTC",
      FYStartMonth: toInt(row.FYStartMonth, 4) || 4,
      RowLimit: toInt(row.RowLimit, 10) || 10,
      ListDateTimeFormat: row.ListDateTimeFormat || null,
    };
  }

  /**
   * Organisation header for printed documents (CI3 Organisation_model::getOrgForReceipt) with its billing
   * address. DevPassword, which CI3 also selects, is left out because this goes to the browser.
   */
  async getHeader(orgUID: number): Promise<Record<string, string | null> | null> {
    const row = await this.db
      .read("Organisation.OrganisationTbl as Org")
      .select(
        "Org.Name as Name",
        "Org.BrandName as BrandName",
        "Org.Logo as Logo",
        "Org.GSTIN as GSTIN",
        "Org.MobileNumber as MobileNumber",
        "Org.EmailAddress as EmailAddress",
        "Org.ShortCode as ShortCode",
        "Org.OrgToken as OrgToken",
        "Addr.Line1 as Line1",
        "Addr.Line2 as Line2",
        "Addr.CityText as CityText",
        "Addr.StateText as StateText",
        "Addr.Pincode as Pincode"
      )
      .leftJoin("Organisation.OrgAddressTbl as Addr", (on) => {
        on.on("Addr.OrgUID", "Org.OrgUID").andOnVal("Addr.AddressType", "=", "Billing").andOnVal("Addr.IsDeleted", "=", 0).andOnVal("Addr.IsActive", "=", 1);
      })
      .where({ "Org.OrgUID": orgUID, "Org.IsDeleted": 0 })
      .first();
    return row ? { ...row, Logo: resolveCdnUrl(row.Logo) } : null;
  }

  // Page size the caller asked for, otherwise the organisation's RowLimit setting (CI3 GenSettings->RowLimit).
  async resolveRowLimit(orgUID: number, requested?: number): Promise<number> {
    return requested ?? (await this.get(orgUID)).RowLimit;
  }
}
