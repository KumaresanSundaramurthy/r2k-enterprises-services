import { Injectable } from "@nestjs/common";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";
import { toInt } from "../../common/utils/php-compat";
import { TelegramNotifier } from "../../libraries/telegram/telegram-notifier";
import { BillingService } from "../../modules/billing/billing.service";
import { billingFy } from "../../core/utils/billing-fy";

type Row = Record<string, unknown>;

export interface PlanRow {
  SectorPlanUID: unknown;
  Price: unknown;
  TaxableAmount: unknown;
  TaxAmount: unknown;
  TotalAmount: unknown;
  TaxRate: unknown;
  DurationDays: unknown;
  PlanName: unknown;
  BillingCycle: unknown;
}

/** Signup_model public methods migrated to NestJS — called from CI3 via CiServerGuard endpoints. */
@Injectable()
export class SubscriptionBillingService {
  constructor(private readonly billing: BillingService) {}

  /** Signup_model::getSectorPlan — plan row with tax breakdown by SectorPlanUID. */
  async getSectorPlan(sectorPlanUID: number): Promise<PlanRow | null> {
    const row = await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select("SPT.SectorPlanUID", "SPT.Price", "SPT.TaxableAmount", "SPT.TaxAmount", "SPT.TotalAmount", "SPT.TaxRate", "SPT.DurationDays", "SP.PlanName", "SP.BillingCycle")
      .where({ "SPT.SectorPlanUID": sectorPlanUID, "SPT.IsActive": 1 })
      .first();
    return (row as PlanRow | undefined) ?? null;
  }

  /** Signup_model::getOrgSubUID — most recent non-cancelled subscription row for the org. */
  async getOrgSubUID(orgUID: number): Promise<{ OrgSubUID: number; OrderUID: number | null } | null> {
    const row = (await erpKnexRead("Billing.OrgSubscriptionTbl")
      .select("OrgSubUID", "OrderUID")
      .where({ OrgUID: orgUID })
      .whereNotIn("Status", ["Cancelled"])
      .orderBy("OrgSubUID", "desc")
      .first()) as Row | undefined;
    if (!row) return null;
    return { OrgSubUID: toInt(row.OrgSubUID), OrderUID: row.OrderUID !== null && row.OrderUID !== undefined ? toInt(row.OrderUID) : null };
  }

  /** Signup_model::getOrgPlanForPayment — subscription row joined with plan details for a given status. */
  async getOrgPlanForPayment(orgUID: number, status: string): Promise<Row | null> {
    const row = await erpKnexRead("Billing.OrgSubscriptionTbl as OS")
      .leftJoin("Billing.SectorPlanTbl as SPT", "SPT.SectorPlanUID", "OS.SectorPlanUID")
      .leftJoin("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select("OS.OrgSubUID", "OS.SectorPlanUID", "OS.EndDate", "SPT.Price", "SPT.DurationDays", "SP.PlanName", "SP.BillingCycle")
      .where({ "OS.OrgUID": orgUID, "OS.Status": status })
      .orderBy("OS.OrgSubUID", "desc")
      .first();
    return (row as Row | undefined) ?? null;
  }

  /** Signup_model::getAvailablePlansForOrg — all active plans for an org's sector. */
  async getAvailablePlansForOrg(orgUID: number): Promise<Row[]> {
    const orgRow = (await erpKnexRead("Organisation.OrganisationTbl")
      .where({ OrgUID: orgUID })
      .first("SectorUID")) as Row | undefined;
    const sectorUID = toInt(orgRow?.SectorUID);

    const planQuery = () =>
      erpKnexRead("Billing.SectorPlanTbl as SPT")
        .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
        .select("SPT.SectorPlanUID", "SPT.Price", "SPT.DurationDays", "SPT.MaxUsers", "SPT.MaxBranches", "SPT.TaxableAmount", "SPT.TaxAmount", "SPT.TotalAmount", "SP.PlanName", "SP.BillingCycle")
        .orderBy("SPT.Price", "asc");

    if (sectorUID > 0) {
      const rows = (await planQuery().where({ "SPT.SectorUID": sectorUID, "SPT.IsActive": 1 })) as Row[];
      if (rows.length > 0) return rows;
    }

    /* Fallback 1: sector unset or has no active plans — all active plans across all sectors. */
    const active = (await planQuery().where({ "SPT.IsActive": 1 })) as Row[];
    if (active.length > 0) return active;

    /* Fallback 2: no active plans at all — return every plan so the subscribe page is never blank. */
    return (await planQuery()) as Row[];
  }

  /** Signup_model::applyPlanMenuFilter — batch-update IsActive on all 4 menu tables based on the plan's allowed modules. */
  async applyPlanMenuFilter(orgUID: number, sectorPlanUID: number): Promise<{ SectorUID: number; PlanUID: number; Price: number; DurationDays: number }> {
    const planMeta = (await erpKnexRead("Billing.SectorPlanTbl")
      .where({ SectorPlanUID: sectorPlanUID, IsActive: 1 })
      .select("SectorUID", "PlanUID", "Price", "DurationDays")
      .first()) as Row | undefined;
    if (!planMeta) throw new Error("Plan not found.");

    const sectorUID = toInt(planMeta.SectorUID);
    const planUID = toInt(planMeta.PlanUID);

    const allowed = new Set<number>();
    if (planUID > 0) {
      const modRows = (await erpKnexRead("Billing.SectorPlanModulesTbl").where({ SectorUID: sectorUID, PlanUID: planUID }).select("ModuleUID")) as Row[];
      for (const r of modRows) allowed.add(toInt(r.ModuleUID));
    }

    const moduleOf = (val: unknown): number | null => (val !== null && val !== "" && val !== undefined ? toInt(val) : null);
    const isAllowed = (mod: number | null) => allowed.size === 0 || (mod !== null && allowed.has(mod));

    const mainMenus = (await erpKnexRead("Modules.MainMenusTbl").where({ OrgUID: orgUID, IsDeleted: 0 }).select("MainMenuUID", "ModuleUID", "IsDirectLink")) as Row[];
    const subMenus = (await erpKnexRead("Modules.SubMenusTbl").where({ OrgUID: orgUID, IsDeleted: 0 }).select("SubMenuUID", "MainMenuUID", "ModuleUID", "ParentSubMenuUID")) as Row[];

    const activeMMSet = new Set<number>();
    for (const sm of subMenus) {
      if (isAllowed(moduleOf(sm.ModuleUID))) activeMMSet.add(toInt(sm.MainMenuUID));
    }
    for (const mm of mainMenus) {
      if (toInt(mm.IsDirectLink) !== 1) continue;
      const mod = moduleOf(mm.ModuleUID);
      if (mod === null || isAllowed(mod)) activeMMSet.add(toInt(mm.MainMenuUID));
    }

    const allMMUIDs = mainMenus.map((m) => toInt(m.MainMenuUID));
    const activeMMList = [...activeMMSet];
    const inactiveMMList = allMMUIDs.filter((id) => !activeMMSet.has(id));

    const activeParents = new Set<number>();
    for (const sm of subMenus) {
      if (!sm.ParentSubMenuUID) continue;
      if (isAllowed(moduleOf(sm.ModuleUID))) activeParents.add(toInt(sm.ParentSubMenuUID));
    }

    const activeSMUIDs: number[] = [];
    const inactiveSMUIDs: number[] = [];
    for (const sm of subMenus) {
      const smUID = toInt(sm.SubMenuUID);
      const isActive = activeParents.has(smUID) || isAllowed(moduleOf(sm.ModuleUID));
      if (isActive) activeSMUIDs.push(smUID);
      else inactiveSMUIDs.push(smUID);
    }

    if (activeMMList.length > 0) {
      await erpKnexWrite("Modules.MainMenusTbl").whereIn("MainMenuUID", activeMMList).update({ IsActive: 1 });
      await erpKnexWrite("UserRole.RoleMainMenusTbl").whereIn("MainMenuUID", activeMMList).update({ IsActive: 1 });
    }
    if (inactiveMMList.length > 0) {
      await erpKnexWrite("Modules.MainMenusTbl").whereIn("MainMenuUID", inactiveMMList).update({ IsActive: 0 });
      await erpKnexWrite("UserRole.RoleMainMenusTbl").whereIn("MainMenuUID", inactiveMMList).update({ IsActive: 0 });
    }
    if (activeSMUIDs.length > 0) {
      await erpKnexWrite("Modules.SubMenusTbl").whereIn("SubMenuUID", activeSMUIDs).update({ IsActive: 1 });
      await erpKnexWrite("UserRole.RoleSubMenusTbl").whereIn("SubMenuUID", activeSMUIDs).update({ IsActive: 1 });
    }
    if (inactiveSMUIDs.length > 0) {
      await erpKnexWrite("Modules.SubMenusTbl").whereIn("SubMenuUID", inactiveSMUIDs).update({ IsActive: 0 });
      await erpKnexWrite("UserRole.RoleSubMenusTbl").whereIn("SubMenuUID", inactiveSMUIDs).update({ IsActive: 0 });
    }

    return { SectorUID: sectorUID, PlanUID: planUID, Price: Number(planMeta.Price), DurationDays: toInt(planMeta.DurationDays) };
  }

  /** Signup_model::orderHasPayment — true when a payment row already exists for the order. */
  async orderHasPayment(orderUID: number): Promise<boolean> {
    const row = await erpKnexRead("Billing.SubscriptionPaymentsTbl").where({ OrderUID: orderUID }).select("PaymentUID").first();
    return !!row;
  }

  /**
   * Signup_model::createPaymentAndInvoice — insert SubscriptionPaymentsTbl +
   * SubscriptionInvoicesTbl rows and generate + upload the PDF.
   * Non-fatal: errors are caught and logged via Telegram.
   */
  async createPaymentAndInvoice(
    orgUID: number,
    orderUID: number,
    plan: PlanRow | null,
    renewalType: string,
    rpOrderId: string,
    rpPaymentId: string,
    rpSignature: string,
    paymentMode: string,
    now: string,
    bankRrn: string = ""
  ): Promise<void> {
    if (orderUID <= 0) return;

    try {
      const totalAmt = Number(plan?.TotalAmount ?? 0);

      await erpKnexWrite("Billing.SubscriptionPaymentsTbl").insert({
        OrderUID: orderUID,
        FinancialYear: billingFy("long"),
        PaymentDate: now,
        Amount: totalAmt,
        Mode: paymentMode,
        PaymentType: paymentMode === "Free" ? "Free" : "Razorpay",
        PaymentID: rpPaymentId,
        GatewayOrderID: rpOrderId,
        GatewaySignature: rpSignature,
        BankRRN: bankRrn || null,
        Status: "Success",
      });

      /* Org billing address for the invoice — read from ReadDb (org exists before this call) */
      const org = (await erpKnexRead("Organisation.OrganisationTbl as O")
        .leftJoin("Organisation.OrgAddressTbl as A", function () {
          this.on("A.OrgUID", "O.OrgUID").andOnVal("A.AddressType", "Billing").andOnVal("A.IsDeleted", 0).andOnVal("A.IsActive", 1);
        })
        .select("O.Name", "O.GSTIN", "O.MobileNumber", "O.EmailAddress", "A.Line1", "A.Line2", "A.CityText", "A.StateText", "A.Pincode")
        .where("O.OrgUID", orgUID)
        .first()) as Row | undefined;

      /* Auto-sequence invoice number e.g. R2K-2627-001 */
      const prefix = `R2K-${billingFy("code")}-`;
      const last = (await erpKnexRead("Billing.SubscriptionInvoicesTbl").where("InvoiceNumber", "like", `${prefix}%`).max("InvoiceNumber as LastInv").first()) as Row | undefined;
      const lastSeq = last?.LastInv ? toInt(String(last.LastInv).split("-").pop()) : 0;
      const invoiceNumber = `${prefix}${String(lastSeq + 1).padStart(3, "0")}`;

      /* Tax figures with 18% GST-inclusive fallback */
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
        org_name: String(org?.Name ?? ""),
        gstin: String(org?.GSTIN ?? ""),
        org_address1: String(org?.Line1 ?? ""),
        org_address2: String(org?.Line2 ?? ""),
        org_city: String(org?.CityText ?? ""),
        org_state: String(org?.StateText ?? ""),
        org_pincode: String(org?.Pincode ?? ""),
        org_phone: String(org?.MobileNumber ?? ""),
        org_email: String(org?.EmailAddress ?? ""),
        plan_name: String(plan?.PlanName ?? ""),
        billing_cycle: String(plan?.BillingCycle ?? ""),
        renewal_type: renewalType,
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
}
