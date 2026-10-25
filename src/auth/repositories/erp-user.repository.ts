import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";
import { nowDateTime } from "../../common/utils/php-compat";
import { ErpUserRow, StepOneUserRow } from "../interfaces/erp-user.interface";

const USER_COLUMNS = [
  "User.UserUID as UserUID",
  "User.FirstName as UserFirstName",
  "User.LastName as UserLastName",
  "User.UserName as UserName",
  "User.EmailAddress as UserEmailAddress",
  "User.Password as UserPassword",
  "User.IsLocked as IsLocked",
  "Roles.RoleUID as UserRoleUID",
  "Roles.Name as UserRoleName",
  "Org.OrgUID as UserOrgUID",
  "User.BranchUID as BranchUID",
  "Branch.Name as BranchName",
  "Branch.BranchCode as BranchCode",
  "Org.Logo as UserOrgLogo",
  "Org.CountryCode as UserOrgCCode",
  "Org.CountryISO2 as UserOrgCISO2",
  "Org.Name as UserOrgName",
  "Org.BrandName as UserOrgBrandName",
  "Org.MobileNumber as UserOrgMobile",
  "Timezone.Timezone",
  "User.CountryCode as UserCountryCode",
  "User.CountryISO2 as UserCountryISO2",
  "User.MobileNumber as UserMobileNumber",
  "User.Image as UserImage",
  "Org.ShortCode as OrgShortCode",
  "Org.OrgToken as OrgToken",
  "Org.StateCode as OrgStateCode",
  "Org.StateName as OrgStateName",
  "User.UILanguage as UILanguage",
  "User.LastLoginOn as LastLoginOn",
  "User.LastLoginDevice as LastLoginDevice",
  "User.LoginExpiryDateTime as LoginExpiryDateTime",
  "User.AuthProvider as AuthProvider",
  "User.PasswordChangedOn as PasswordChangedOn",
  "Org.SectorUID as SectorUID",
  "Org.IsOnboardingComplete as IsOnboardingComplete",
  "Org.IsEmailVerified as OrgIsEmailVerified",
  "Org.EmailAddress as OrgEmail",
];

@Injectable()
export class ErpUserRepository {
  private loginUserQuery(): Knex.QueryBuilder {
    return erpKnexRead("Users.UserTbl as User")
      .select(USER_COLUMNS)
      .leftJoin("UserRole.RolesTbl as Roles", "Roles.RoleUID", "User.RoleUID")
      .leftJoin("Organisation.OrganisationTbl as Org", "Org.OrgUID", "User.OrgUID")
      .leftJoin("Organisation.BranchesTbl as Branch", "Branch.BranchUID", "User.BranchUID")
      .leftJoin("Global.TimezoneTbl as Timezone", "Timezone.TimezoneUID", "Org.TimezoneUID")
      .where({ "User.IsActive": 1, "User.IsDeleted": 0, "User.HasLoginAccess": 1 });
  }

  // Returns every match so callers can reject an identifier that is ambiguous (CI3 requires exactly one).
  async findLoginUsersByIdentifier(identifier: string): Promise<ErpUserRow[]> {
    return this.loginUserQuery().where((qb) => qb.where("User.UserName", identifier).orWhere("User.EmailAddress", identifier));
  }

  async findLoginUserByUID(userUID: number): Promise<ErpUserRow | null> {
    const row = await this.loginUserQuery().where("User.UserUID", userUID).first();
    return row ?? null;
  }

  async findStepOneUser(identifier: string): Promise<StepOneUserRow | null> {
    const row = await erpKnexRead("Users.UserTbl as U")
      .select(
        "U.UserUID",
        "U.UserName",
        "U.FirstName",
        "U.LastName",
        "U.IsLocked",
        "U.Image",
        "U.OrgUID",
        "U.LoginExpiryDateTime",
        "U.AuthProvider",
        "U.Password",
        "O.IsEmailVerified",
        "O.EmailAddress as OrgEmail"
      )
      .leftJoin("Organisation.OrganisationTbl as O", "O.OrgUID", "U.OrgUID")
      .where((qb) => qb.where("U.UserName", identifier).orWhere("U.EmailAddress", identifier))
      .where({ "U.IsActive": 1, "U.IsDeleted": 0, "U.HasLoginAccess": 1 })
      .first();
    return row ?? null;
  }

  async findActiveUserByEmail(
    email: string
  ): Promise<{ UserUID: string; FirstName: string | null; EmailAddress: string; UserName: string } | null> {
    const row = await erpKnexRead("Users.UserTbl")
      .select("UserUID", "FirstName", "EmailAddress", "UserName")
      .where({ EmailAddress: email, IsActive: 1, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  async findPasswordHash(userUID: number): Promise<string | null> {
    const row = await erpKnexRead("Users.UserTbl").select("Password").where({ UserUID: userUID }).first();
    return row?.Password ?? null;
  }

  async getCurrentSessionToken(userUID: number): Promise<string | null> {
    const row = await erpKnexRead("Users.UserTbl")
      .select("CurrentSessionToken")
      .where({ UserUID: userUID, IsActive: 1, IsDeleted: 0 })
      .first();
    return row?.CurrentSessionToken ?? null;
  }

  async update(userUID: number, data: Record<string, unknown>): Promise<void> {
    await erpKnexWrite("Users.UserTbl").where({ UserUID: userUID }).update(data);
  }

  async lock(userUID: number): Promise<void> {
    await this.update(userUID, { IsLocked: 1 });
  }

  async updatePassword(userUID: number, passwordHash: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.update(userUID, { Password: passwordHash, PasswordChangedOn: nowDateTime(), ...extra });
  }

  async clearSessionToken(userUID: number): Promise<void> {
    await this.update(userUID, { CurrentSessionToken: null });
  }

  async getRecentPasswordHashes(userUID: number, limit: number): Promise<string[]> {
    const rows = await erpKnexRead("Users.PasswordHistoryTbl")
      .select("Password")
      .where({ UserUID: userUID })
      .orderBy("CreatedOn", "desc")
      .limit(limit);
    return rows.map((row: { Password: string }) => row.Password);
  }

  async addPasswordHistory(userUID: number, passwordHash: string, keepLast = 5): Promise<void> {
    await erpKnexWrite("Users.PasswordHistoryTbl").insert({ UserUID: userUID, Password: passwordHash });
    await erpKnexWrite.raw(
      `DELETE FROM Users.PasswordHistoryTbl
        WHERE UserUID = ?
          AND HistoryUID NOT IN (
            SELECT h FROM (
              SELECT HistoryUID AS h FROM Users.PasswordHistoryTbl WHERE UserUID = ? ORDER BY CreatedOn DESC LIMIT ?
            ) tmp
          )`,
      [userUID, userUID, keepLast]
    );
  }

  async findByPasswordSetToken(
    token: string
  ): Promise<{ UserUID: string; FirstName: string | null; EmailAddress: string; IsPasswordSet: string | null } | null> {
    const row = await erpKnexRead("Users.UserTbl")
      .select("UserUID", "FirstName", "EmailAddress", "IsPasswordSet")
      .where({ PasswordSetToken: token, IsDeleted: 0 })
      .first();
    return row ?? null;
  }
}
