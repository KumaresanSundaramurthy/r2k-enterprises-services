import { Injectable } from "@nestjs/common";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";

@Injectable()
export class OrganisationRepository {
  async findByVerifyToken(
    token: string
  ): Promise<{ OrgUID: string; IsEmailVerified: string | null; EmailVerifyExpiry: string | null } | null> {
    const row = await erpKnexRead("Organisation.OrganisationTbl")
      .select("OrgUID", "IsEmailVerified", "EmailVerifyExpiry")
      .where({ EmailVerifyToken: token })
      .first();
    return row ?? null;
  }

  async findUnverifiedByEmail(email: string): Promise<{ OrgUID: string; OrgEmail: string; FirstName: string | null } | null> {
    const row = await erpKnexRead("Organisation.OrganisationTbl as O")
      .select("O.OrgUID", "O.EmailAddress as OrgEmail", "U.FirstName")
      .leftJoin("Users.UserTbl as U", function () {
        this.on("U.OrgUID", "O.OrgUID")
          .andOn("U.IsActive", erpKnexRead.raw("1"))
          .andOn("U.IsDeleted", erpKnexRead.raw("0"));
      })
      .where({ "O.EmailAddress": email, "O.IsEmailVerified": 0 })
      .orderBy("U.UserUID", "asc")
      .first();
    return row ?? null;
  }

  async findUnverifiedByUserName(
    userName: string
  ): Promise<{ OrgUID: string; OrgEmail: string; FirstName: string | null } | null> {
    const row = await erpKnexRead("Users.UserTbl as U")
      .select("O.OrgUID", "O.EmailAddress as OrgEmail", "U.FirstName")
      .join("Organisation.OrganisationTbl as O", "O.OrgUID", "U.OrgUID")
      .where({ "U.UserName": userName, "U.IsActive": 1, "U.IsDeleted": 0, "O.IsEmailVerified": 0 })
      .first();
    return row ?? null;
  }

  async update(orgUID: number, data: Record<string, unknown>): Promise<void> {
    await erpKnexWrite("Organisation.OrganisationTbl").where({ OrgUID: orgUID }).update(data);
  }

  async setEmailVerifyToken(orgUID: number, token: string, expiry: string): Promise<number> {
    return erpKnexWrite("Organisation.OrganisationTbl")
      .where({ OrgUID: orgUID })
      .update({ EmailVerifyToken: token, EmailVerifyExpiry: expiry });
  }

  async isMobileTaken(mobile: string, excludeOrgUID: number): Promise<boolean> {
    const row = await erpKnexRead("Organisation.OrganisationTbl")
      .count({ total: "*" })
      .where({ MobileNumber: mobile, IsDeleted: 0 })
      .andWhereNot({ OrgUID: excludeOrgUID })
      .first();
    return Number(row?.total ?? 0) > 0;
  }

  async isGstinTaken(gstin: string, excludeOrgUID: number): Promise<boolean> {
    const row = await erpKnexRead("Organisation.OrganisationTbl")
      .count({ total: "*" })
      .where({ GSTIN: gstin, IsDeleted: 0 })
      .andWhereNot({ OrgUID: excludeOrgUID })
      .first();
    return Number(row?.total ?? 0) > 0;
  }

  async insertBillingAddress(data: Record<string, unknown>): Promise<void> {
    await erpKnexWrite("Organisation.OrgAddressTbl").insert({ AddressType: "Billing", IsActive: 1, IsDeleted: 0, ...data });
  }

  async updateHeadOfficeBranch(orgUID: number, data: Record<string, unknown>): Promise<void> {
    await erpKnexWrite("Organisation.BranchesTbl").where({ OrgUID: orgUID, IsHeadOffice: 1 }).update(data);
  }

  async getIndianStates(): Promise<{ name: string; iso2: string }[]> {
    return erpKnexRead("Global.StatesTbl")
      .select("name", "iso2")
      .where({ country_code: "IN", flag: 1 })
      .orderBy("name", "asc");
  }

  async getTimezones(): Promise<Record<string, string | null>[]> {
    return erpKnexRead("Global.TimezoneTbl as Tzone").select(
      "Tzone.TimezoneUID as TimezoneUID",
      "Tzone.CountryCode as CountryCode",
      "Tzone.CountryName as CountryName",
      "Tzone.Timezone as Timezone",
      "Tzone.GmtOffset as GmtOffset",
      "Tzone.UTCOffset as UTCOffset",
      "Tzone.RawOffset as RawOffset"
    );
  }
}
