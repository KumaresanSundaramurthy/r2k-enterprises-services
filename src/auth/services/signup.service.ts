import { Injectable, Logger } from "@nestjs/common";
import { randomInt } from "crypto";
import type { Knex } from "knex";
import { isEmail } from "class-validator";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";
import { CiValidationError } from "../../core/response/ci-response";
import { hashPassword, nowDateTime, toInt } from "../../common/utils/php-compat";
import { TelegramNotifier } from "../../libraries/telegram/telegram-notifier";
import { BillingService } from "../../modules/billing/billing.service";
import { ErpUserRepository } from "../repositories/erp-user.repository";
import { RequestMeta } from "../utils/device-info";
import { EmailVerificationService } from "./email-verification.service";
import { LoginResult, LoginService } from "./login.service";
import { SubscriptionCheckService } from "./subscription-check.service";
import { billingFy, calcPlanEndDate } from "../../core/utils/billing-fy";

type Row = Record<string, string | null>;
type Form = Record<string, unknown>;

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const ORG_TOKEN_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FAILED_MESSAGE = "Registration failed. Please try again or contact support.";

const text = (form: Form, key: string) => String(form[key] ?? "").trim();

interface GoogleProfile {
  email: string;
  sub: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
  hd: string;
}

interface PlanRow {
  SectorPlanUID: string;
  Price: string | null;
  TaxableAmount: string | null;
  TaxAmount: string | null;
  TotalAmount: string | null;
  TaxRate: string | null;
  DurationDays: string | null;
  PlanName: string | null;
  BillingCycle: string | null;
}

/** CI3 Signup::doSignup + Signup_model::registerOrganisation — the form signup: a new org with its admin, then auto-login. */
@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name);

  constructor(
    private readonly users: ErpUserRepository,
    private readonly login: LoginService,
    private readonly emailVerification: EmailVerificationService,
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionCheckService
  ) {}

  async doSignup(form: Form, meta: RequestMeta): Promise<LoginResult & { Message: string; IsPaidPlan: boolean }> {
    await this.validate(form);

    let registered: { orgUID: number; userUID: number; isPaidPlan: boolean };
    try {
      registered = await this.registerOrganisation(form);
    } catch (err) {
      TelegramNotifier.error("Signup_model::registerOrganisation", err, { OrgEmail: text(form, "OrgEmail") });
      throw new CiValidationError(FAILED_MESSAGE);
    }

    // Auto-login: the same session a password login creates
    const user = await this.users.findLoginUserByUID(registered.userUID);
    if (!user) {
      throw new CiValidationError("Account created but auto-login failed. Please sign in manually.");
    }
    const session = await this.login.completeLogin(user, "WEB", user.UserName, meta);
    return { ...session, Message: "Organisation registered successfully!", IsPaidPlan: registered.isPaidPlan };
  }

  /**
   * Signup::googleAuth — Google "Sign up" button. An existing account (org or user with this email) is signed in;
   * otherwise a new org is created from the Google profile (Signup_model::registerOrganisationViaGoogle).
   */
  async googleAuth(credential: string, sectorPlanUID: number, meta: RequestMeta): Promise<LoginResult & { Redirect: string; IsPaidPlan: boolean }> {
    if (!credential) throw new CiValidationError("No credential received.");

    const g = await this.verifyGoogleToken(credential);
    const email = g.email.trim().toLowerCase();

    const orgExists = await erpKnexRead("Organisation.OrganisationTbl").where({ EmailAddress: email, IsDeleted: 0 }).first("OrgUID");
    const userExists = await erpKnexRead("Users.UserTbl").where({ EmailAddress: email, IsDeleted: 0, IsActive: 1, HasLoginAccess: 1 }).first("UserUID");

    if (orgExists || userExists) {
      // Existing account — sign in
      const matches = await this.users.findLoginUsersByIdentifier(email);
      if (matches.length === 0) throw new CiValidationError("Unable to load account.");
      const user = matches[0];
      try {
        this.login.assertSocialSignInAllowed(user);
      } catch (err) {
        throw new CiValidationError((err as Error).message);
      }
      const subscription = await this.subscriptions.check(toInt(user.UserUID));
      if (!subscription.isValid) throw new CiValidationError(subscription.message ?? "Subscription check failed.");
      const session = await this.login.completeLogin(user, "GOOGLE", email, meta);
      return { ...session, Redirect: "dashboard", IsPaidPlan: false };
    }

    // New account
    let registered: { userUID: number; isPaidPlan: boolean };
    try {
      registered = await this.registerOrganisationViaGoogle(g, sectorPlanUID);
    } catch (err) {
      TelegramNotifier.error("Signup_model::registerOrganisationViaGoogle", err, { Email: email });
      throw new CiValidationError("Something went wrong. Please try again.");
    }
    const user = await this.users.findLoginUserByUID(registered.userUID);
    if (!user) throw new CiValidationError("Account created but login failed.");
    const session = await this.login.completeLogin(user, "GOOGLE", email, meta);
    return { ...session, Redirect: registered.isPaidPlan ? "subscribe" : "onboarding", IsPaidPlan: registered.isPaidPlan };
  }

  // Google's tokeninfo check of the ID token: email + subject present, issued for our client
  private async verifyGoogleToken(credential: string): Promise<GoogleProfile> {
    let g: Record<string, unknown>;
    try {
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(10_000) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      g = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      TelegramNotifier.error("Signup::googleAuth — Google token verification failed", err);
      throw new CiValidationError("Something went wrong. Please try again.");
    }
    if (!g.email || !g.sub) throw new CiValidationError("Incomplete Google profile.");
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (clientId && String(g.aud ?? "") !== clientId) throw new CiValidationError("Token audience mismatch.");
    const str = (key: string) => String(g[key] ?? "").trim();
    return { email: str("email"), sub: str("sub"), given_name: str("given_name"), family_name: str("family_name"), picture: str("picture"), locale: str("locale"), hd: str("hd") };
  }

  // Signup_model::registerOrganisationViaGoogle — no mobile / state yet (onboarding asks for them); email already verified by Google
  async registerOrganisationViaGoogle(g: GoogleProfile, sectorPlanUID: number): Promise<{ orgUID: number; userUID: number; isPaidPlan: boolean }> {
    const now = nowDateTime();
    const email = g.email.toLowerCase();
    const orgName = g.given_name || "Organisation";
    const shortCode = await this.generateShortCode(orgName);
    const orgToken = await this.generateOrgToken();
    const username = await this.generateUniqueUsername(g.given_name);
    const countryCode = "+91";

    let sectorUID = 0;
    let seedPlanUID = 0;
    if (sectorPlanUID > 0) {
      const meta = await erpKnexRead("Billing.SectorPlanTbl").where({ SectorPlanUID: sectorPlanUID, IsActive: 1 }).first("SectorUID", "PlanUID");
      sectorUID = toInt(meta?.SectorUID);
      seedPlanUID = toInt(meta?.PlanUID);
    }
    if (sectorUID === 0) {
      const sector = await erpKnexRead("Billing.SectorsTbl").where({ IsActive: 1 }).first("SectorUID");
      sectorUID = toInt(sector?.SectorUID);
    }
    const plan = sectorPlanUID > 0 ? await this.getSectorPlan(sectorPlanUID) : null;

    const { orgUID, userUID, subscription } = await erpKnexWrite.transaction(async (trx) => {
      const insert = async (table: string, row: Record<string, unknown>) => toInt((await trx(table).insert(row))[0]);

      const orgUID = await insert("Organisation.OrganisationTbl", {
        Name: orgName,
        BrandName: orgName,
        ShortCode: shortCode,
        OrgToken: orgToken,
        SectorUID: sectorUID,
        CountryCode: countryCode,
        CountryISO2: "IN",
        MobileNumber: null,
        EmailAddress: email,
        GSTIN: null,
        StateCode: null,
        StateName: null,
        TimezoneUID: 181,
        IsEmailVerified: 1,
        IsOnboardingComplete: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: 0,
        UpdatedBy: 0,
      });

      const branchUID = await insert("Organisation.BranchesTbl", {
        OrgUID: orgUID,
        Name: orgName,
        BranchCode: shortCode,
        ContactPerson: `${g.given_name} ${g.family_name}`.trim(),
        MobileNumber: null,
        CountryCode: countryCode,
        CountryISO2: "IN",
        EmailAddress: email,
        GSTIN: null,
        StateText: null,
        IsHeadOffice: 1,
        IsWarehouse: 1,
        IsSalesPoint: 1,
        IsDispatchPoint: 1,
        IsServiceCenter: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: 0,
        UpdatedBy: 0,
      });

      await this.insertDefaultSettings(trx, orgUID, shortCode);

      const role = (name: string, by: number) => ({ Name: name, OrgUID: orgUID, BranchUID: branchUID, IsDefault: 1, IsGlobal: 0, IsActive: 1, IsDeleted: 0, CreatedBy: by, UpdatedBy: by });
      const roleUID = await insert("UserRole.RolesTbl", role("Super Admin", 0));

      const userUID = await insert("Users.UserTbl", {
        EmployeeCode: `${shortCode}-0001`,
        FirstName: g.given_name,
        LastName: g.family_name || null,
        UserName: username,
        EmailAddress: email,
        Password: null,
        Image: g.picture || null,
        GoogleSub: g.sub || null,
        GoogleLocale: g.locale || null,
        GoogleHD: g.hd || null,
        AuthProvider: "google",
        OrgUID: orgUID,
        BranchUID: branchUID,
        RoleUID: roleUID,
        CountryCode: countryCode,
        CountryISO2: "IN",
        MobileNumber: null,
        HasLoginAccess: 1,
        IsPasswordSet: 0,
        IsActive: 1,
        IsDeleted: 0,
        UILanguage: "en",
        CreatedBy: 0,
        UpdatedBy: 0,
      });

      const by = { CreatedBy: userUID, UpdatedBy: userUID };
      await trx("Organisation.OrganisationTbl").where({ OrgUID: orgUID }).update(by);
      await trx("Organisation.BranchesTbl").where({ BranchUID: branchUID }).update(by);
      await trx("UserRole.RolesTbl").where({ RoleUID: roleUID }).update(by);
      await trx("Users.UserTbl").where({ UserUID: userUID }).update(by);

      for (const name of ["Admin", "Sales Manager", "Sales Executive", "Accountant"]) {
        await insert("UserRole.RolesTbl", role(name, userUID));
      }
      await trx("Users.UserBranchAccessTbl").insert({ UserUID: userUID, OrgUID: orgUID, BranchUID: branchUID, IsDefault: 1, IsActive: 1, CreatedBy: userUID });

      const subscription = await this.assignPlanSubscription(trx, orgUID, sectorPlanUID, plan);
      await this.seedMenusFromSector(trx, orgUID, sectorUID, seedPlanUID, roleUID, userUID);
      return { orgUID, userUID, subscription };
    });

    await this.runSignupSeed(orgUID, userUID, shortCode).catch((err) => {
      this.logger.error(`runSignupSeed threw unexpectedly: ${(err as Error).message}`);
      TelegramNotifier.error("SignupService::runSignupSeed — unexpected throw (google)", err, { OrgUID: orgUID });
    });

    if (!subscription.isPaid && subscription.orderUID > 0) {
      await this.createFreePaymentAndInvoice(orgUID, subscription.orderUID, plan, now);
      await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgUID: orgUID }).update({ OrderUID: null });
      await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgUID: orgUID }).whereNull("FirstPaidOn").update({ FirstPaidOn: now });
    }
    return { orgUID, userUID, isPaidPlan: subscription.isPaid };
  }

  // Signup_model::_generateUniqueUsername — the first name's letters/digits (max 12), then 1, 2, … until free
  private async generateUniqueUsername(name: string): Promise<string> {
    const base = name.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12) || "user";
    let attempt = base;
    for (let i = 1; await erpKnexRead("Users.UserTbl").where({ UserName: attempt, IsDeleted: 0 }).first("UserUID"); i++) {
      attempt = `${base}${i}`;
    }
    return attempt;
  }

  private async runSignupSeed(orgUID: number, userUID: number, shortCode: string): Promise<void> {
    const url = process.env.SIGNUP_SEED_URL;
    if (!url) return;

    let raw: string;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.text();
    } catch (err) {
      this.logger.error(`Signup seed fetch failed: ${(err as Error).message}`);
      TelegramNotifier.error("SignupService::runSignupSeed — fetch failed", err, { OrgUID: orgUID });
      return;
    }

    const sql = raw
      .replace(/^﻿/, "")                                    // strip UTF-8 BOM
      .replace(/\{\{OrgUid\}\}/g,       String(orgUID))
      .replace(/\{\{UserUid\}\}/g,      String(userUID))
      .replace(/\{\{OrgShortCode\}\}/g, `'${shortCode.replace(/'/g, "''")}'`)
      /* Add Settings. schema prefix + convert to INSERT IGNORE in one pass.
         Cannot use `USE Settings` — each erpKnexWrite.raw() may get a different
         pooled connection with no default database. */
      .replace(/\bINSERT\s+INTO\s+`(\w+)`/gi, "INSERT IGNORE INTO `Settings`.`$1`");

    /* Keep only statements that start with INSERT — strips comment-only chunks
       that the semicolon split produces from lines like "/* comment *\/;" */
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => /^INSERT\b/i.test(s));

    this.logger.log(`Signup seed OrgUID=${orgUID}: executing ${statements.length} statements`);

    for (const stmt of statements) {
      try {
        await erpKnexWrite.raw(stmt);
        this.logger.log(`Signup seed OK: ${stmt.slice(0, 80).replace(/\s+/g, " ")}`);
      } catch (err) {
        this.logger.error(`Signup seed FAILED [${(err as Error).message}]: ${stmt.slice(0, 150).replace(/\s+/g, " ")}`);
        TelegramNotifier.error("SignupService::runSignupSeed — statement failed", err, { OrgUID: orgUID, Stmt: stmt.slice(0, 200) });
      }
    }
  }

  // OrgSettingsTbl defaults shared by both signups
  private async insertDefaultSettings(trx: Knex.Transaction, orgUID: number, shortCode: string): Promise<void> {
    await trx("Settings.OrgSettingsTbl").insert({
      OrgSettingsUID: orgUID,
      OrgUID: orgUID,
      CurrenySymbol: "₹",
      FYStartMonth: 4,
      RowLimit: 10,
      QtyMaxLength: 2,
      SerialNoDisplay: 0,
      EnableStorage: 0,
      MandatoryStorage: 0,
      MaxShippingAddr: 3,
      FormDateFormat: "d-m-Y",
      ListDateFormat: "d-m-Y",
      PrintDateFormat: "d-m-Y",
      FormDateTimeFormat: "d-m-Y h:i A",
      ListDateTimeFormat: "d-m-Y h:i A",
      PrintDateTimeFormat: "d-m-Y h:i A",
      ShowStats: 0,
      StatsDefaultOpen: 0,
      EnableAIAssistant: "No",
      TwoStepLogin: 1,
      EmpCodePrefix: shortCode,
      EmpCodeSeparator: "-",
      EmpCodeDigits: 4,
    });
  }

  private async validate(form: Form): Promise<void> {
    const required: Record<string, string> = {
      OrgName: "Organisation name",
      BrandName: "Brand name",
      ShortCode: "Short code",
      OrgMobile: "Mobile number",
      OrgEmail: "Email address",
      StateCode: "State",
      StateName: "State",
      TimezoneUID: "Timezone",
      AdminFirstName: "First name",
      AdminUsername: "Username",
      AdminPassword: "Password",
      ConfirmPassword: "Confirm password",
    };
    for (const [field, label] of Object.entries(required)) {
      if (!text(form, field)) throw new CiValidationError(`${label} is required.`);
    }
    for (const [field, label] of Object.entries({ OrgName: "Organisation name", BrandName: "Brand name", AdminFirstName: "First name" })) {
      if ([...text(form, field)].length < 3) throw new CiValidationError(`${label} must be at least 3 characters.`);
    }
    if (!/^[A-Z]{3}$/.test(text(form, "ShortCode").toUpperCase())) {
      throw new CiValidationError("Short code must be exactly 3 uppercase letters (A–Z).");
    }
    if (!isEmail(text(form, "OrgEmail"))) {
      throw new CiValidationError("Please enter a valid email address.");
    }
    const mobile = String(form.OrgMobile ?? "").replace(/\D/g, "");
    if (!/^\d{10}$/.test(mobile)) {
      throw new CiValidationError("Mobile number must be 10 digits.");
    }
    const password = String(form.AdminPassword ?? "");
    if (password.length < 8) throw new CiValidationError("Password must be at least 8 characters.");
    if (password !== String(form.ConfirmPassword ?? "")) throw new CiValidationError("Passwords do not match.");

    if (text(form, "GSTIN")) {
      const gstin = text(form, "GSTIN").toUpperCase();
      if (!GSTIN_PATTERN.test(gstin)) throw new CiValidationError("GSTIN format is invalid.");
      const taken = await erpKnexRead("Organisation.OrganisationTbl").where({ GSTIN: gstin, IsDeleted: 0 }).whereNot("GSTIN", "").first("OrgUID");
      if (taken) throw new CiValidationError("This GSTIN is already registered.");
    }
    const emailTaken = await erpKnexRead("Users.UserTbl").where({ EmailAddress: text(form, "OrgEmail").toLowerCase(), IsDeleted: 0 }).first("UserUID");
    if (emailTaken) throw new CiValidationError("This email address is already registered.");

    const mobileInOrg = await erpKnexRead("Organisation.OrganisationTbl").where({ MobileNumber: mobile, IsDeleted: 0 }).first("OrgUID");
    const mobileInUser = mobileInOrg ? null : await erpKnexRead("Users.UserTbl").where({ MobileNumber: mobile, IsDeleted: 0 }).first("UserUID");
    if (mobileInOrg || mobileInUser) throw new CiValidationError("This mobile number is already registered.");

    const usernameTaken = await erpKnexRead("Users.UserTbl").where({ UserName: text(form, "AdminUsername").toLowerCase(), IsDeleted: 0 }).first("UserUID");
    if (usernameTaken) throw new CiValidationError("This username is already taken. Please choose another.");
  }

  // Signup_model::registerOrganisation
  private async registerOrganisation(form: Form): Promise<{ orgUID: number; userUID: number; isPaidPlan: boolean }> {
    const now = nowDateTime();
    const orgName = text(form, "OrgName");
    let shortCode = text(form, "ShortCode").toUpperCase();
    if (!/^[A-Z]{3}$/.test(shortCode)) shortCode = await this.generateShortCode(orgName);
    const orgToken = await this.generateOrgToken();
    const gstin = text(form, "GSTIN") ? text(form, "GSTIN").toUpperCase() : null;
    const countryCode = text(form, "CountryCode") || "+91";
    const email = text(form, "OrgEmail").toLowerCase();
    const mobile = text(form, "OrgMobile");

    // Sector + plan of the chosen plan, resolved before the transaction
    const sectorPlanUID = toInt(form.SectorPlanUID);
    let sectorUID = 0;
    let seedPlanUID = 0;
    if (sectorPlanUID > 0) {
      const meta = await erpKnexRead("Billing.SectorPlanTbl").where({ SectorPlanUID: sectorPlanUID, IsActive: 1 }).first("SectorUID", "PlanUID");
      sectorUID = toInt(meta?.SectorUID);
      seedPlanUID = toInt(meta?.PlanUID);
    }
    const plan = sectorPlanUID > 0 ? await this.getSectorPlan(sectorPlanUID) : null;

    const result = await erpKnexWrite.transaction(async (trx) => {
      const insert = async (table: string, row: Record<string, unknown>) => toInt((await trx(table).insert(row))[0]);

      const orgUID = await insert("Organisation.OrganisationTbl", {
        Name: orgName,
        BrandName: text(form, "BrandName") || orgName,
        ShortCode: shortCode,
        OrgToken: orgToken,
        SectorUID: sectorUID,
        CountryCode: countryCode,
        CountryISO2: "IN",
        MobileNumber: mobile,
        EmailAddress: email,
        GSTIN: gstin,
        GSTINValidation: gstin ? 1 : 0,
        PANNumber: gstin ? gstin.substring(2, 12) : null,
        StateCode: text(form, "StateCode"),
        StateName: text(form, "StateName"),
        TimezoneUID: toInt(form.TimezoneUID) || 181,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: 0,
        UpdatedBy: 0,
      });

      // Billing address when given (the no-GSTIN flow)
      if (text(form, "AddrLine1")) {
        await insert("Organisation.OrgAddressTbl", {
          OrgUID: orgUID,
          AddressType: "Billing",
          Line1: text(form, "AddrLine1"),
          Line2: text(form, "AddrLine2") || null,
          CityText: text(form, "AddrCity") || null,
          StateText: text(form, "StateName") || null,
          Pincode: text(form, "AddrPincode") || null,
          IsActive: 1,
          IsDeleted: 0,
          CreatedBy: 0,
          UpdatedBy: 0,
        });
      }

      const adminName = `${text(form, "AdminFirstName")} ${text(form, "AdminLastName")}`.trim();
      const branchUID = await insert("Organisation.BranchesTbl", {
        OrgUID: orgUID,
        Name: orgName,
        BranchCode: shortCode,
        ContactPerson: adminName,
        MobileNumber: mobile,
        CountryCode: countryCode,
        CountryISO2: "IN",
        EmailAddress: email,
        GSTIN: gstin,
        StateText: text(form, "StateName"),
        IsHeadOffice: 1,
        IsWarehouse: 1,
        IsSalesPoint: 1,
        IsDispatchPoint: 1,
        IsServiceCenter: 0,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: 0,
        UpdatedBy: 0,
      });

      await this.insertDefaultSettings(trx, orgUID, shortCode);

      const role = (name: string, by: number) => ({ Name: name, OrgUID: orgUID, BranchUID: branchUID, IsDefault: 1, IsGlobal: 0, IsActive: 1, IsDeleted: 0, CreatedBy: by, UpdatedBy: by });
      const roleUID = await insert("UserRole.RolesTbl", role("Super Admin", 0));

      const passwordHash = await hashPassword(String(form.AdminPassword ?? ""));
      const userUID = await insert("Users.UserTbl", {
        EmployeeCode: `${shortCode}-0001`,
        FirstName: text(form, "AdminFirstName"),
        LastName: text(form, "AdminLastName") || null,
        UserName: text(form, "AdminUsername").toLowerCase(),
        EmailAddress: email,
        Password: passwordHash,
        PasswordChangedOn: now,
        OrgUID: orgUID,
        BranchUID: branchUID,
        RoleUID: roleUID,
        CountryCode: countryCode,
        CountryISO2: "IN",
        MobileNumber: mobile,
        HasLoginAccess: 1,
        IsPasswordSet: 1,
        IsActive: 1,
        IsDeleted: 0,
        UILanguage: "en",
        CreatedBy: 0,
        UpdatedBy: 0,
      });

      // The signup password counts toward the "last 3 passwords" rule
      await trx("Users.PasswordHistoryTbl").insert({ UserUID: userUID, Password: passwordHash });

      // CreatedBy / UpdatedBy now point at the new user
      const by = { CreatedBy: userUID, UpdatedBy: userUID };
      await trx("Organisation.OrganisationTbl").where({ OrgUID: orgUID }).update(by);
      await trx("Organisation.BranchesTbl").where({ BranchUID: branchUID }).update(by);
      await trx("UserRole.RolesTbl").where({ RoleUID: roleUID }).update(by);
      await trx("Users.UserTbl").where({ UserUID: userUID }).update(by);

      // Default roles without permissions — the admin sets them up in Roles settings
      for (const name of ["Admin", "Sales Manager", "Sales Executive", "Accountant"]) {
        await insert("UserRole.RolesTbl", role(name, userUID));
      }

      await trx("Users.UserBranchAccessTbl").insert({ UserUID: userUID, OrgUID: orgUID, BranchUID: branchUID, IsDefault: 1, IsActive: 1, CreatedBy: userUID });

      const subscription = await this.assignPlanSubscription(trx, orgUID, sectorPlanUID, plan);
      await this.seedMenusFromSector(trx, orgUID, sectorUID, seedPlanUID, roleUID, userUID);
      return { orgUID, userUID, subscription };
    });

    const { orgUID, userUID, subscription } = result;

    // Free plan: payment + invoice now, then FirstPaidOn
    if (!subscription.isPaid && subscription.orderUID > 0) {
      await this.createFreePaymentAndInvoice(orgUID, subscription.orderUID, plan, now);
      await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgUID: orgUID }).update({ OrderUID: null });
      await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgUID: orgUID }).whereNull("FirstPaidOn").update({ FirstPaidOn: now });
    }

    await this.runSignupSeed(orgUID, userUID, shortCode).catch((err) => {
      this.logger.error(`runSignupSeed threw unexpectedly: ${(err as Error).message}`);
      TelegramNotifier.error("SignupService::runSignupSeed — unexpected throw", err, { OrgUID: orgUID });
    });

    // Verification email — a failure does not undo the signup
    await this.emailVerification.sendVerificationEmail(orgUID, text(form, "AdminFirstName"), email, text(form, "AppBaseUrl") || undefined).catch((err) => {
      this.logger.error(`Verification email for org ${orgUID} failed: ${(err as Error).message}`);
      TelegramNotifier.error("Signup_model::sendVerificationEmail", err, { OrgUID: orgUID, ToEmail: email });
    });

    return { orgUID, userUID, isPaidPlan: subscription.isPaid };
  }

  // Signup_model::getSectorPlan
  private async getSectorPlan(sectorPlanUID: number): Promise<PlanRow | null> {
    const row = await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select("SPT.SectorPlanUID", "SPT.Price", "SPT.TaxableAmount", "SPT.TaxAmount", "SPT.TotalAmount", "SPT.TaxRate", "SPT.DurationDays", "SP.PlanName", "SP.BillingCycle")
      .where({ "SPT.SectorPlanUID": sectorPlanUID, "SPT.IsActive": 1 })
      .first();
    return (row as PlanRow | undefined) ?? null;
  }

  // Signup_model::_assignPlanSubscription — no plan chosen (0) or a paid plan starts as PendingPayment
  private async assignPlanSubscription(trx: Knex.Transaction, orgUID: number, sectorPlanUID: number, plan: PlanRow | null) {
    const price = plan ? Number(plan.Price ?? 0) : 0;
    const isPaid = price > 0;
    const durationDays = plan ? Math.max(1, toInt(plan.DurationDays ?? 30) || 30) : 30;
    const endDate = calcPlanEndDate(durationDays);
    const status = isPaid || sectorPlanUID === 0 ? "PendingPayment" : "Active";

    const [orgSubUID] = await trx("Billing.OrgSubscriptionTbl").insert({
      OrgUID: orgUID,
      SectorPlanUID: sectorPlanUID > 0 ? sectorPlanUID : 1,
      FinancialYear: billingFy("long"),
      StartDate: nowDateTime(),
      EndDate: endDate,
      Status: status,
      AutoRenew: 0,
      GracePeriodDays: 7,
    });

    let orderUID = 0;
    if (toInt(orgSubUID) > 0 && sectorPlanUID > 0) {
      const amount = (value: string | null | undefined) => (value === null || value === undefined ? price : Number(value));
      const [newOrderUID] = await trx("Billing.SubscriptionOrdersTbl").insert({
        OrgUID: orgUID,
        SectorPlanUID: sectorPlanUID,
        OrgSubUID: orgSubUID,
        FinancialYear: billingFy("long"),
        RenewalType: isPaid ? "New" : "Trial",
        DueDate: endDate,
        Amount: isPaid ? amount(plan?.TaxableAmount) : 0,
        DiscountAmount: 0,
        TaxAmount: isPaid ? Number(plan?.TaxAmount ?? 0) : 0,
        NetAmount: isPaid ? amount(plan?.TotalAmount) : 0,
        Status: isPaid ? "Pending" : "Waived",
        IsPaid: isPaid ? 0 : 1,
        CreatedBy: null,
      });
      orderUID = toInt(newOrderUID);
      await trx("Billing.OrgSubscriptionTbl").where({ OrgSubUID: orgSubUID }).update({ OrderUID: orderUID });
    }
    return { isPaid, orderUID };
  }

  // Signup_model::_seedMenusFromSector — the sector's menus copied to the org; the plan's modules decide which are active
  private async seedMenusFromSector(trx: Knex.Transaction, orgUID: number, sectorUID: number, planUID: number, roleUID: number, userUID: number): Promise<void> {
    if (sectorUID <= 0) return;

    const allowed = new Set<number>();
    if (planUID > 0) {
      const rows = await erpKnexRead("Billing.SectorPlanModulesTbl").where({ SectorUID: sectorUID, PlanUID: planUID }).select("ModuleUID");
      for (const r of rows as Row[]) allowed.add(toInt(r.ModuleUID));
    }
    // No allowed list (trial / unconfigured plan) = every menu active
    const isAllowed = (moduleUID: number | null) => allowed.size === 0 || (moduleUID !== null && allowed.has(moduleUID));
    const moduleOf = (value: string | null) => (value !== null && value !== "" ? toInt(value) : null);

    const mainMenus = (await erpKnexRead("Modules.SectorMainMenusTbl").where({ SectorUID: sectorUID, IsDeleted: 0 }).orderBy("Sorting", "asc")) as Row[];
    if (mainMenus.length === 0) return;
    const subMenus = (await erpKnexRead("Modules.SectorSubMenusTbl")
      .where({ SectorUID: sectorUID, IsDeleted: 0 })
      .orderBy("ParentSectorSubMenuUID", "asc")
      .orderBy("Sorting", "asc")) as Row[];

    // A main menu is active when one of its submenus is allowed; a direct link by its own module
    const activeMain = new Set<number>();
    for (const sm of subMenus) {
      if (isAllowed(moduleOf(sm.ModuleUID))) activeMain.add(toInt(sm.SectorMainMenuUID));
    }
    for (const mm of mainMenus) {
      if (toInt(mm.IsDirectLink) !== 1) continue;
      const moduleUID = moduleOf(mm.ModuleUID);
      if (moduleUID === null || isAllowed(moduleUID)) activeMain.add(toInt(mm.SectorMainMenuUID));
    }

    const mainMenuMap = new Map<number, number>(); // SectorMainMenuUID → MainMenuUID
    const mainActive = new Map<number, number>();
    for (const mm of mainMenus) {
      const sectorMMUID = toInt(mm.SectorMainMenuUID);
      const isActive = activeMain.has(sectorMMUID) ? 1 : 0;
      const [id] = await trx("Modules.MainMenusTbl").insert({
        OrgUID: orgUID,
        Source: "Plan",
        Name: mm.Name,
        Icon: mm.Icon ?? "",
        IsDirectLink: mm.IsDirectLink ?? 0,
        DirectUrl: mm.DirectUrl ?? "",
        ModuleUID: moduleOf(mm.ModuleUID),
        Sorting: mm.Sorting ?? 0,
        IsActive: isActive,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      mainMenuMap.set(sectorMMUID, toInt(id));
      mainActive.set(sectorMMUID, isActive);
    }

    const roleMainMenuMap = new Map<number, number>(); // MainMenuUID → RoleMainMenuUID
    let sort = 1;
    for (const [sectorMMUID, mainMenuUID] of mainMenuMap) {
      const [id] = await trx("UserRole.RoleMainMenusTbl").insert({
        RoleUID: roleUID,
        MainMenuUID: mainMenuUID,
        Sorting: sort++,
        CanView: 1,
        CanCreate: 1,
        CanEdit: 1,
        CanDelete: 1,
        IsActive: mainActive.get(sectorMMUID) ?? 0,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      roleMainMenuMap.set(mainMenuUID, toInt(id));
    }

    // Parent headers (no module) are active when any child is allowed
    const activeParents = new Set<number>();
    for (const sm of subMenus) {
      if (sm.ParentSectorSubMenuUID === null || sm.ParentSectorSubMenuUID === "") continue;
      if (isAllowed(moduleOf(sm.ModuleUID))) activeParents.add(toInt(sm.ParentSectorSubMenuUID));
    }

    const subMenuMap = new Map<number, number>(); // SectorSubMenuUID → SubMenuUID
    const subRows: { subMenuUID: number; roleMainMenuUID: number; isActive: number }[] = [];
    for (const sm of subMenus) {
      const mainMenuUID = mainMenuMap.get(toInt(sm.SectorMainMenuUID)) ?? 0;
      if (!mainMenuUID) continue;
      const moduleUID = moduleOf(sm.ModuleUID);
      const sectorSubUID = toInt(sm.SectorSubMenuUID);
      const isActive = activeParents.has(sectorSubUID) || isAllowed(moduleUID) ? 1 : 0;
      const oldParent = sm.ParentSectorSubMenuUID !== null && sm.ParentSectorSubMenuUID !== "" ? toInt(sm.ParentSectorSubMenuUID) : 0;
      const [id] = await trx("Modules.SubMenusTbl").insert({
        OrgUID: orgUID,
        Source: "Plan",
        MainMenuUID: mainMenuUID,
        Name: sm.Name,
        UrlPath: sm.UrlPath ?? "",
        ParentSubMenuUID: oldParent && subMenuMap.has(oldParent) ? subMenuMap.get(oldParent) : null,
        IsParent: sm.IsParent ?? 0,
        Icon: sm.Icon ?? "",
        ModuleUID: moduleUID,
        Sorting: sm.Sorting ?? 0,
        IsActive: isActive,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      subMenuMap.set(sectorSubUID, toInt(id));
      subRows.push({ subMenuUID: toInt(id), roleMainMenuUID: roleMainMenuMap.get(mainMenuUID) ?? 0, isActive });
    }

    sort = 1;
    for (const sub of subRows) {
      await trx("UserRole.RoleSubMenusTbl").insert({
        RoleUID: roleUID,
        RoleMainMenuUID: sub.roleMainMenuUID,
        SubMenuUID: sub.subMenuUID,
        Sorting: sort++,
        CanView: 1,
        CanCreate: 1,
        CanEdit: 1,
        CanDelete: 1,
        IsActive: sub.isActive,
        IsDeleted: 0,
      });
    }
  }

  // Signup_model::createPaymentAndInvoice for a free plan — never fails the signup
  private async createFreePaymentAndInvoice(orgUID: number, orderUID: number, plan: PlanRow | null, now: string): Promise<void> {
    try {
      const totalAmt = Number(plan?.TotalAmount ?? 0);
      await erpKnexWrite("Billing.SubscriptionPaymentsTbl").insert({
        OrderUID: orderUID,
        FinancialYear: billingFy("long"),
        PaymentDate: now,
        Amount: totalAmt,
        Mode: "Free",
        PaymentType: "Free",
        PaymentID: "",
        GatewayOrderID: "",
        GatewaySignature: "",
        BankRRN: null,
        Status: "Success",
      });

      // The org row was just written — read it from the write connection
      const org = (await erpKnexWrite("Organisation.OrganisationTbl as O")
        .leftJoin("Organisation.OrgAddressTbl as A", function () {
          this.on("A.OrgUID", "O.OrgUID").andOnVal("A.AddressType", "Billing").andOnVal("A.IsDeleted", 0).andOnVal("A.IsActive", 1);
        })
        .select("O.Name", "O.GSTIN", "O.MobileNumber", "O.EmailAddress", "A.Line1", "A.Line2", "A.CityText", "A.StateText", "A.Pincode")
        .where("O.OrgUID", orgUID)
        .first()) as Row | undefined;

      // Next number in the year's series, e.g. R2K-2627-001
      const prefix = `R2K-${billingFy("code")}-`;
      const last = (await erpKnexWrite("Billing.SubscriptionInvoicesTbl").where("InvoiceNumber", "like", `${prefix}%`).max("InvoiceNumber as LastInv").first()) as Row | undefined;
      const lastSeq = last?.LastInv ? toInt(String(last.LastInv).split("-").pop()) : 0;
      const invoiceNumber = `${prefix}${String(lastSeq + 1).padStart(3, "0")}`;

      // 18% GST-inclusive figures when the plan has none
      const taxRate = Number(plan?.TaxRate ?? 0) > 0 ? Number(plan?.TaxRate) : 18;
      const taxableAmt = Number(plan?.TaxableAmount ?? 0) > 0 ? Number(plan?.TaxableAmount) : Math.round(((totalAmt * 100) / (100 + taxRate)) * 100) / 100;
      const taxAmt = Number(plan?.TaxAmount ?? 0) > 0 ? Number(plan?.TaxAmount) : Math.round(((totalAmt * taxRate) / (100 + taxRate)) * 100) / 100;
      const invoiceDate = now.slice(0, 10);

      const [invoiceUID] = await erpKnexWrite("Billing.SubscriptionInvoicesTbl").insert({
        OrderUID: orderUID,
        InvoiceNumber: invoiceNumber,
        FinancialYear: billingFy("long"),
        InvoiceDate: invoiceDate,
        OrgName: org?.Name ?? "",
        GSTIN: org?.GSTIN || null,
        OrgAddress1: org?.Line1 || null,
        OrgAddress2: org?.Line2 || null,
        OrgCity: org?.CityText || null,
        OrgState: org?.StateText || null,
        OrgPincode: org?.Pincode || null,
        OrgPhone: org?.MobileNumber || null,
        OrgEmail: org?.EmailAddress || null,
        TaxableAmount: taxableAmt,
        TaxRate: taxRate,
        TaxAmount: taxAmt,
        TotalAmount: totalAmt,
        PDFPath: null,
      });

      const pdfUrl = await this.billing.generateAndUpload({
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        financial_year: billingFy("long"),
        org_name: org?.Name ?? "",
        gstin: org?.GSTIN ?? "",
        org_address1: org?.Line1 ?? "",
        org_address2: org?.Line2 ?? "",
        org_city: org?.CityText ?? "",
        org_state: org?.StateText ?? "",
        org_pincode: org?.Pincode ?? "",
        org_phone: org?.MobileNumber ?? "",
        org_email: org?.EmailAddress ?? "",
        plan_name: plan?.PlanName ?? "",
        billing_cycle: plan?.BillingCycle ?? "",
        renewal_type: "New",
        taxable_amount: taxableAmt,
        tax_rate: taxRate,
        tax_amount: taxAmt,
        total_amount: totalAmt,
        order_uid: orderUID,
        org_uid: orgUID,
      });
      if (pdfUrl) {
        await erpKnexWrite("Billing.SubscriptionInvoicesTbl").where({ InvoiceUID: invoiceUID }).update({ PDFPath: pdfUrl });
      }
    } catch (err) {
      TelegramNotifier.error("Signup_model::createPaymentAndInvoice", err, { OrgUID: orgUID, OrderUID: orderUID });
    }
  }

  // Signup_model::_generateShortCode — first 3 letters of the name, then a numeric suffix until free
  private async generateShortCode(orgName: string): Promise<string> {
    const base = orgName.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3).padEnd(3, "X");
    let attempt = base;
    for (let suffix = 1; await erpKnexRead("Organisation.OrganisationTbl").where({ ShortCode: attempt }).first("OrgUID"); suffix++) {
      const sfx = String(suffix);
      attempt = base.slice(0, 3 - sfx.length) + sfx;
    }
    return attempt;
  }

  // Signup_model::_generateOrgToken — 12 unambiguous characters not used by another org
  private async generateOrgToken(): Promise<string> {
    for (;;) {
      let token = "";
      for (let i = 0; i < 12; i++) token += ORG_TOKEN_CHARS[randomInt(ORG_TOKEN_CHARS.length)];
      if (!(await erpKnexRead("Organisation.OrganisationTbl").where({ OrgToken: token }).first("OrgUID"))) return token;
    }
  }
}
