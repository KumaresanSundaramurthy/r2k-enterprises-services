import { Injectable } from "@nestjs/common";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";
import { toInt } from "../../common/utils/php-compat";
import { TelegramNotifier } from "../../libraries/telegram/telegram-notifier";
import { SubscriptionBillingService, PlanRow } from "./subscription-billing.service";
import { billingFy, calcPlanEndDate, addDays } from "../../core/utils/billing-fy";

type Row = Record<string, unknown>;

export interface ChangePlanPaymentData {
  paid: boolean;
  mode: string | null;
  amount: number;
  discount: number;
  tax: number;
  notes: string | null;
  paymentId?: string;
  gatewayOrderId?: string;
  gatewaySignature?: string;
}

function splitGST(inclusiveTotal: number, taxRate: number): { base: number; tax: number; total: number } {
  const base = Math.round((inclusiveTotal * 100) / (100 + taxRate) * 100) / 100;
  const tax = Math.round((inclusiveTotal - base) * 100) / 100;
  return { base, tax, total: inclusiveTotal };
}

@Injectable()
export class BillingPlanService {
  constructor(private readonly billingOps: SubscriptionBillingService) {}

  /** BillingPlan_model::getOrgSubscription */
  async getOrgSubscription(orgUID: number): Promise<Row | null> {
    const row = await erpKnexRead("Billing.OrgSubscriptionTbl as OS")
      .leftJoin("Billing.SectorPlanTbl as SPT", "SPT.SectorPlanUID", "OS.SectorPlanUID")
      .leftJoin("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .leftJoin("Billing.SectorsTbl as S", "S.SectorUID", "SPT.SectorUID")
      .select(
        "OS.OrgSubUID", "OS.OrgUID", "OS.SectorPlanUID",
        "OS.StartDate", "OS.EndDate", "OS.Status", "OS.AutoRenew", "OS.GracePeriodDays",
        erpKnexRead.raw("COALESCE(SP.PlanName, 'Trial') AS PlanName"),
        "SP.PlanCode", "SP.BillingCycle",
        "SPT.Price", "SPT.DurationDays", "SPT.MaxUsers", "SPT.MaxBranches",
        "S.SectorUID", "S.SectorCode", "S.SectorName",
        erpKnexRead.raw("DATEDIFF(OS.EndDate, CURDATE()) AS DaysRemaining")
      )
      .where("OS.OrgUID", orgUID)
      .whereNotIn("OS.Status", ["Cancelled"])
      .orderBy("OS.StartDate", "desc")
      .first();
    return (row as Row | undefined) ?? null;
  }

  /** BillingPlan_model::getAvailablePlans — excludes TRIAL PlanCode, includes SectorUID. */
  async getAvailablePlans(orgUID: number): Promise<Row[]> {
    const rows = await erpKnexRead("Organisation.OrganisationTbl as O")
      .join("Billing.SectorPlanTbl as SPT", function (j) {
        j.on("SPT.SectorUID", "O.SectorUID").andOnVal("SPT.IsActive", 1);
      })
      .join("Billing.SubscriptionPlansTbl as SP", function (j) {
        j.on("SP.PlanUID", "SPT.PlanUID").andOnVal("SP.IsActive", 1);
      })
      .join("Billing.SectorsTbl as S", "S.SectorUID", "O.SectorUID")
      .select(
        "SPT.SectorPlanUID", "SP.PlanUID", "SP.PlanName", "SP.PlanCode", "SP.BillingCycle",
        "SPT.Price", "SPT.DurationDays", "SPT.MaxUsers", "SPT.MaxBranches",
        "SPT.TaxRate", "SPT.TaxableAmount", "SPT.TaxAmount", "SPT.TotalAmount",
        "S.SectorUID", "S.SectorCode", "S.SectorName"
      )
      .where("O.OrgUID", orgUID)
      .whereNot("SP.PlanCode", "TRIAL")
      .orderBy("SPT.Price", "asc");
    return rows as Row[];
  }

  /** BillingPlan_model::getOrderHistory */
  async getOrderHistory(orgUID: number, limit = 20): Promise<Row[]> {
    const rows = await erpKnexRead("Billing.SubscriptionOrdersTbl as SO")
      .leftJoin("Billing.SectorPlanTbl as SPT", "SPT.SectorPlanUID", "SO.SectorPlanUID")
      .leftJoin("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .leftJoin("Billing.SubscriptionInvoicesTbl as SI", "SI.OrderUID", "SO.OrderUID")
      .select(
        "SO.OrderUID", "SO.RenewalType", "SO.OrderDate", "SO.DueDate",
        "SO.NetAmount", "SO.Status", "SO.PaymentMode", "SO.PaidOn",
        erpKnexRead.raw("COALESCE(SP.PlanName, 'Trial') AS PlanName"),
        "SI.InvoiceUID", "SI.InvoiceNumber", "SI.PDFPath"
      )
      .where("SO.OrgUID", orgUID)
      .orderBy("SO.OrderDate", "desc")
      .limit(limit);
    return rows as Row[];
  }

  /** BillingPlan_model::getPendingOrder */
  async getPendingOrder(orgUID: number, orderUID: number): Promise<Row | null> {
    const row = await erpKnexRead("Billing.SubscriptionOrdersTbl as SO")
      .leftJoin("Billing.SectorPlanTbl as SPT", "SPT.SectorPlanUID", "SO.SectorPlanUID")
      .leftJoin("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select(
        "SO.OrderUID", "SO.OrgUID", "SO.OrgSubUID", "SO.SectorPlanUID",
        "SO.RenewalType", "SO.Amount", "SO.DiscountAmount", "SO.TaxAmount", "SO.NetAmount",
        "SO.DueDate", "SO.Status", "SO.FinancialYear",
        erpKnexRead.raw("COALESCE(SP.PlanName, 'Trial') AS PlanName"),
        "SPT.TaxableAmount as PlanTaxableAmount", "SPT.TaxAmount as PlanTaxAmt",
        "SPT.TotalAmount as PlanTotalAmount", "SP.BillingCycle"
      )
      .where("SO.OrgUID", orgUID)
      .where("SO.OrderUID", orderUID)
      .where("SO.Status", "Pending")
      .first();
    return (row as Row | undefined) ?? null;
  }

  /** BillingPlan_model::getPlanChangeLockStatus */
  async getPlanChangeLockStatus(orgUID: number): Promise<{ IsLocked: boolean; UnlocksAt: string | null; DaysRemaining: number }> {
    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);

    let row = (await erpKnexRead("Billing.SubscriptionOrdersTbl")
      .select("OrderDate as CreatedOn")
      .where("OrgUID", orgUID)
      .whereIn("RenewalType", ["Upgrade", "Downgrade"])
      .where("OrderDate", ">=", cutoff)
      .orderBy("OrderDate", "desc")
      .first()) as Row | undefined;

    if (!row) {
      row = (await erpKnexRead("Billing.ScheduledPlanChangeTbl")
        .select("CreatedOn")
        .where("OrgUID", orgUID)
        .whereIn("Status", ["Pending", "Activated"])
        .where("CreatedOn", ">=", cutoff)
        .orderBy("CreatedOn", "desc")
        .first()) as Row | undefined;
    }

    if (row) {
      const unlocksAt = new Date(new Date(String(row.CreatedOn).replace(" ", "T")).getTime() + 5 * 24 * 60 * 60 * 1000);
      if (unlocksAt.getTime() > Date.now()) {
        const daysRemaining = Math.ceil((unlocksAt.getTime() - Date.now()) / 86400000);
        return { IsLocked: true, UnlocksAt: unlocksAt.toISOString().replace("T", " ").slice(0, 19), DaysRemaining: daysRemaining };
      }
    }
    return { IsLocked: false, UnlocksAt: null, DaysRemaining: 0 };
  }

  /** BillingPlan_model::getScheduledPlanChange */
  async getScheduledPlanChange(orgUID: number): Promise<Row | null> {
    const row = await erpKnexRead("Billing.ScheduledPlanChangeTbl as SC")
      .leftJoin("Billing.SectorPlanTbl as SPT", "SPT.SectorPlanUID", "SC.NewSectorPlanUID")
      .leftJoin("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select(
        "SC.ScheduledChangeUID", "SC.ChangeType", "SC.BillingOption",
        "SC.ScheduledStartDate", "SC.ScheduledEndDate", "SC.NewSectorPlanUID",
        "SP.PlanName as NewPlanName"
      )
      .where("SC.OrgUID", orgUID)
      .where("SC.Status", "Pending")
      .whereNotNull("SC.OrderUID")
      .orderBy("SC.CreatedOn", "desc")
      .first();
    return (row as Row | undefined) ?? null;
  }

  /** BillingPlan_model::getModuleComparison */
  async getModuleComparison(orgUID: number, newSectorPlanUID: number): Promise<{ Added: Row[]; Removed: Row[]; HasData: boolean }> {
    const sub = await this.getOrgSubscription(orgUID);
    if (!sub) return { Added: [], Removed: [], HasData: false };

    const newPlanRow = (await erpKnexRead("Billing.SectorPlanTbl")
      .select("PlanUID", "SectorUID")
      .where({ SectorPlanUID: newSectorPlanUID })
      .first()) as Row | undefined;
    if (!newPlanRow) return { Added: [], Removed: [], HasData: false };

    const sectorUID = toInt(newPlanRow.SectorUID);
    const newPlanUID = toInt(newPlanRow.PlanUID);

    const curPlanRow = sub.SectorPlanUID
      ? ((await erpKnexRead("Billing.SectorPlanTbl").select("PlanUID").where({ SectorPlanUID: toInt(sub.SectorPlanUID) }).first()) as Row | undefined)
      : undefined;
    const curPlanUID = curPlanRow ? toInt(curPlanRow.PlanUID) : 0;

    const fetchModules = (planUID: number) =>
      erpKnexRead("Billing.SectorPlanModulesTbl as PM")
        .leftJoin("Modules.ModuleTbl as M", "M.ModuleUID", "PM.ModuleUID")
        .select("M.ModuleUID", "M.DisplayName", "M.Description")
        .where("PM.SectorUID", sectorUID)
        .where("PM.PlanUID", planUID) as unknown as Promise<Row[]>;

    const [curModules, newModules] = await Promise.all([
      curPlanUID > 0 ? fetchModules(curPlanUID) : Promise.resolve<Row[]>([]),
      fetchModules(newPlanUID),
    ]);

    const curUIDs = curModules.map((m) => toInt(m.ModuleUID));
    const newUIDs = newModules.map((m) => toInt(m.ModuleUID));
    const Added = newModules.filter((m) => !curUIDs.includes(toInt(m.ModuleUID)));
    const Removed = curModules.filter((m) => !newUIDs.includes(toInt(m.ModuleUID)));
    return { Added, Removed, HasData: curModules.length > 0 || newModules.length > 0 };
  }

  /** BillingPlan_model::calculatePlanChangeDetails */
  async calculatePlanChangeDetails(orgUID: number, newSectorPlanUID: number): Promise<Row> {
    const sub = await this.getOrgSubscription(orgUID);
    if (!sub) return { Error: true, Message: "No active subscription found." };

    const newPlan = (await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select(
        "SPT.SectorPlanUID", "SPT.PlanUID", "SPT.SectorUID",
        "SPT.Price", "SPT.TaxableAmount", "SPT.TaxAmount", "SPT.TotalAmount",
        "SPT.DurationDays", "SPT.TaxRate",
        "SP.PlanName", "SP.PlanCode", "SP.BillingCycle"
      )
      .where({ "SPT.SectorPlanUID": newSectorPlanUID, "SPT.IsActive": 1 })
      .first()) as Row | undefined;

    if (!newPlan) return { Error: true, Message: "Plan not found." };

    const today = new Date().toISOString().slice(0, 10);
    const currentEndDate = String(sub.EndDate ?? today).slice(0, 10);
    const remainingDays = Math.max(0, Math.ceil((new Date(currentEndDate).getTime() - new Date(today).getTime()) / 86400000));
    const curDuration = Math.max(1, toInt(sub.DurationDays ?? 30));
    const dailyRateCur = Number(sub.Price) / curDuration;
    const remainingCredit = Math.round(dailyRateCur * remainingDays * 100) / 100;

    const newTotalAmount = Number(newPlan.TotalAmount);
    const newTaxableAmount = Number(newPlan.TaxableAmount);
    const newTaxAmount = Number(newPlan.TaxAmount);
    const newDuration = Math.max(1, toInt(newPlan.DurationDays));
    const taxRate = Math.max(0, Number(newPlan.TaxRate ?? 18));
    const dailyRateNew = newTotalAmount / newDuration;
    const isUpgrade = newTotalAmount > Number(sub.Price);

    const result: Row = {
      Error: false,
      ChangeType: isUpgrade ? "Upgrade" : "Downgrade",
      RemainingDays: remainingDays,
      RemainingCredit: remainingCredit,
      CurrentEndDate: currentEndDate,
      CurrentPlan: sub,
      NewPlan: newPlan,
    };

    /* Option UA: immediate upgrade, pro-rated */
    const ua_net = Math.max(0, Math.round((newTotalAmount - remainingCredit) * 100) / 100);
    const ua = splitGST(ua_net, taxRate);
    result.OptionUA = { StartDate: today, EndDate: addDays(today, newDuration), BaseAmount: ua.base, TaxAmount: ua.tax, TaxRate: taxRate, TotalAmount: ua.total, CreditUsed: Math.min(remainingCredit, newTotalAmount), Recommended: true };

    /* Option UB: upgrade after current plan expires */
    const ub_start = addDays(currentEndDate, 1);
    result.OptionUB = { StartDate: ub_start, EndDate: addDays(ub_start, newDuration), BaseAmount: newTaxableAmount, TaxAmount: newTaxAmount, TaxRate: taxRate, TotalAmount: newTotalAmount, CreditUsed: 0, Recommended: false };

    /* Option DA: immediate downgrade, extend days */
    const bonusDays = dailyRateNew > 0 ? Math.floor(remainingCredit / dailyRateNew) : 0;
    const da_days = newDuration + bonusDays;
    result.OptionDA = { StartDate: today, EndDate: addDays(today, da_days), BaseAmount: newTaxableAmount, TaxAmount: newTaxAmount, TaxRate: taxRate, TotalAmount: newTotalAmount, BonusDays: bonusDays, TotalDays: da_days, CreditUsed: remainingCredit, Recommended: false };

    /* Option DB: immediate downgrade, reduce payment */
    const db_net = Math.max(0, Math.round((newTotalAmount - remainingCredit) * 100) / 100);
    const db = splitGST(db_net, taxRate);
    result.OptionDB = { StartDate: today, EndDate: addDays(today, newDuration), BaseAmount: db.base, TaxAmount: db.tax, TaxRate: taxRate, TotalAmount: db.total, CreditUsed: Math.min(remainingCredit, newTotalAmount), Recommended: true };

    /* Option DC: downgrade after current plan expires */
    const dc_start = addDays(currentEndDate, 1);
    result.OptionDC = { StartDate: dc_start, EndDate: addDays(dc_start, newDuration), BaseAmount: newTaxableAmount, TaxAmount: newTaxAmount, TaxRate: taxRate, TotalAmount: newTotalAmount, CreditUsed: 0, Recommended: false };

    return result;
  }

  /** BillingPlan_model::changePlan — the core plan change / renewal transaction. */
  async changePlan(
    orgUID: number,
    newSectorPlanUID: number,
    renewalType: string,
    adminRoleUID: number,
    userUID: number,
    paymentData: ChangePlanPaymentData
  ): Promise<{ EndDate: string; Message: string }> {
    /* 1. Validate plan */
    const plan = (await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select(
        "SPT.SectorPlanUID", "SPT.SectorUID", "SPT.PlanUID",
        "SPT.Price", "SPT.DurationDays", "SPT.TaxRate",
        "SPT.TaxableAmount", "SPT.TaxAmount", "SPT.TotalAmount",
        "SP.PlanName", "SP.BillingCycle"
      )
      .where({ "SPT.SectorPlanUID": newSectorPlanUID, "SPT.IsActive": 1 })
      .first()) as (PlanRow & Row) | undefined;

    if (!plan) throw new Error("Invalid or inactive plan selected.");

    /* 2. Get previous subscription row for EndDate base + audit trail */
    const prevRow = (await erpKnexRead("Billing.OrgSubscriptionTbl")
      .select("SectorPlanUID", "EndDate")
      .where("OrgUID", orgUID)
      .whereNotIn("Status", ["Cancelled"])
      .orderBy("StartDate", "desc")
      .first()) as Row | undefined;

    const prevSectorPlanUID = prevRow ? toInt(prevRow.SectorPlanUID) : null;
    const endDate = calcPlanEndDate(toInt(plan.DurationDays), prevRow?.EndDate as string | undefined);
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const fyValue = billingFy("long");
    const paidAmount = paymentData.amount > 0 ? paymentData.amount : Number(plan.Price);

    /* 3. Apply menu activation / deactivation */
    await this.billingOps.applyPlanMenuFilter(orgUID, newSectorPlanUID);

    /* 4. Update OrgSubscriptionTbl */
    await erpKnexWrite.raw(
      "UPDATE Billing.OrgSubscriptionTbl SET SectorPlanUID=?, FinancialYear=?, StartDate=?, EndDate=?, Status='Active', UpdatedBy=?, UpdatedOn=? WHERE OrgUID=? AND Status NOT IN ('Cancelled') ORDER BY StartDate DESC LIMIT 1",
      [newSectorPlanUID, fyValue, now, endDate, userUID || null, now, orgUID]
    );

    /* 5. Get OrgSubUID after update */
    const orgSubRow = (await erpKnexRead("Billing.OrgSubscriptionTbl")
      .select("OrgSubUID")
      .where("OrgUID", orgUID)
      .whereNotIn("Status", ["Cancelled"])
      .orderBy("StartDate", "desc")
      .first()) as Row | undefined;
    const orgSubUID = orgSubRow ? toInt(orgSubRow.OrgSubUID) : 0;

    /* 6. Create order row */
    const [orderUID] = await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
      OrgUID:            orgUID,
      SectorPlanUID:     newSectorPlanUID,
      OrgSubUID:         orgSubUID || null,
      FinancialYear:     fyValue,
      RenewalType:       renewalType,
      DueDate:           endDate,
      Amount:            paidAmount,
      DiscountAmount:    paymentData.discount ?? 0,
      TaxAmount:         paymentData.tax ?? 0,
      NetAmount:         paidAmount,
      Status:            paymentData.paid ? "Paid" : "Pending",
      PaymentMode:       paymentData.mode ?? null,
      PaidOn:            paymentData.paid ? now : null,
      PrevSectorPlanUID: prevSectorPlanUID,
      CreatedBy:         userUID || null,
    });

    /* 7. Payment + invoice (fire-and-forget for paid orders) */
    if (paymentData.paid && orderUID > 0) {
      this.billingOps
        .createPaymentAndInvoice(
          orgUID, orderUID, plan, renewalType,
          paymentData.gatewayOrderId ?? "",
          paymentData.paymentId ?? "",
          paymentData.gatewaySignature ?? "",
          paymentData.mode ?? "Manual",
          now, ""
        )
        .catch((err: unknown) => TelegramNotifier.error("BillingPlanService::changePlan createPaymentAndInvoice", err, { orgUID, orderUID }));
    }

    return { EndDate: endDate, Message: `Plan changed to ${String(plan.PlanName)} successfully.` };
  }

  /** BillingPlan_model::schedulePlanChange — schedule a future plan change (options UB / DC). */
  async schedulePlanChange(
    orgUID: number,
    newSectorPlanUID: number,
    changeType: string,
    billingOption: string,
    scheduledStart: string,
    scheduledEnd: string,
    adminRoleUID: number,
    userUID: number,
    paymentData: ChangePlanPaymentData
  ): Promise<{ ScheduledStart: string; ScheduledEnd: string; Message: string }> {
    const plan = (await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select("SPT.SectorPlanUID", "SPT.SectorUID", "SPT.PlanUID", "SPT.Price", "SPT.DurationDays", "SP.PlanName", "SP.BillingCycle")
      .where({ "SPT.SectorPlanUID": newSectorPlanUID, "SPT.IsActive": 1 })
      .first()) as Row | undefined;

    if (!plan) throw new Error("Invalid plan selected.");

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const fyValue = billingFy("long");
    const paidAmount = paymentData.amount > 0 ? paymentData.amount : Number(plan.Price);

    const curSub = (await erpKnexRead("Billing.OrgSubscriptionTbl")
      .select("OrgSubUID", "SectorPlanUID")
      .where("OrgUID", orgUID)
      .whereNotIn("Status", ["Cancelled", "Superseded"])
      .orderBy("StartDate", "desc")
      .first()) as Row | undefined;

    const [orderUID] = await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
      OrgUID:            orgUID,
      SectorPlanUID:     newSectorPlanUID,
      OrgSubUID:         curSub ? toInt(curSub.OrgSubUID) : null,
      FinancialYear:     fyValue,
      RenewalType:       changeType,
      OrderDate:         now,
      DueDate:           scheduledEnd + " 23:59:59",
      Amount:            paidAmount,
      DiscountAmount:    paymentData.discount ?? 0,
      TaxAmount:         paymentData.tax ?? 0,
      NetAmount:         paidAmount,
      Status:            paymentData.paid ? "Paid" : "Pending",
      PaymentMode:       paymentData.mode ?? null,
      PaidOn:            paymentData.paid ? now : null,
      PrevSectorPlanUID: curSub ? toInt(curSub.SectorPlanUID) : null,
      Notes:             paymentData.notes ?? null,
      CreatedBy:         userUID || null,
    });

    await erpKnexWrite("Billing.ScheduledPlanChangeTbl").insert({
      OrgUID:               orgUID,
      CurrentSectorPlanUID: curSub ? toInt(curSub.SectorPlanUID) : newSectorPlanUID,
      NewSectorPlanUID:     newSectorPlanUID,
      ChangeType:           changeType,
      BillingOption:        billingOption,
      ScheduledStartDate:   scheduledStart,
      ScheduledEndDate:     scheduledEnd,
      Status:               "Pending",
      OrderUID:             orderUID,
      Notes:                paymentData.notes ?? null,
      CreatedBy:            userUID || null,
    });

    if (paymentData.paid && orderUID > 0) {
      await erpKnexWrite("Billing.SubscriptionPaymentsTbl").insert({
        OrderUID:      orderUID,
        FinancialYear: fyValue,
        PaymentDate:   now,
        Amount:        paidAmount,
        Mode:          paymentData.mode ?? null,
        PaymentID:     null,
        Status:        "Success",
      });
    }

    return { ScheduledStart: scheduledStart, ScheduledEnd: scheduledEnd, Message: `Plan change scheduled. ${String(plan.PlanName)} will activate on ${scheduledStart}.` };
  }

  /** Record a manual payment on a pending subscription order. */
  async recordPayment(orgUID: number, orderUID: number, mode: string, amount: number): Promise<void> {
    const orderRow = (await erpKnexRead("Billing.SubscriptionOrdersTbl")
      .select("OrderUID", "Status")
      .where({ OrderUID: orderUID, OrgUID: orgUID })
      .first()) as Row | undefined;

    if (!orderRow) throw new Error("Order not found.");
    if (orderRow.Status === "Paid") throw new Error("This order is already paid.");

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const fyValue = billingFy("long");

    await erpKnexWrite("Billing.SubscriptionPaymentsTbl").insert({
      OrderUID: orderUID, FinancialYear: fyValue, PaymentDate: now,
      Amount: amount, Mode: mode, PaymentID: null, GatewayOrderID: null,
      GatewaySignature: null, Status: "Success",
    });

    await erpKnexWrite("Billing.SubscriptionOrdersTbl")
      .where({ OrderUID: orderUID })
      .update({ Status: "Paid", IsPaid: 1, PaidOn: now, PaymentMode: mode });

    /* Activate the latest non-cancelled subscription for this org */
    await erpKnexWrite.raw(
      "UPDATE Billing.OrgSubscriptionTbl SET Status='Active' WHERE OrgUID = (SELECT OrgUID FROM Billing.SubscriptionOrdersTbl WHERE OrderUID = ?) AND Status NOT IN ('Cancelled', 'Active') ORDER BY StartDate DESC LIMIT 1",
      [orderUID]
    );
  }

  /** BillingPlan_model::getModuleCountByPlan */
  async getModuleCountByPlan(sectorUID: number): Promise<{ PlanUID: number; Cnt: number }[]> {
    const rows = (await erpKnexRead("Billing.SectorPlanModulesTbl")
      .select("PlanUID")
      .count("* as Cnt")
      .where("SectorUID", sectorUID)
      .groupBy("PlanUID")) as Row[];
    return rows.map((r) => ({ PlanUID: toInt(r.PlanUID), Cnt: toInt(r.Cnt) }));
  }

  /** BillingPlan_model::getSubscriptionOrderByUID */
  async getSubscriptionOrderByUID(orgUID: number, orderUID: number): Promise<Row | null> {
    const row = (await erpKnexRead("Billing.SubscriptionOrdersTbl")
      .select("OrderUID", "Status", "NetAmount")
      .where({ OrderUID: orderUID, OrgUID: orgUID })
      .first()) as Row | undefined;
    return row ?? null;
  }

  /** BillingPlan_model::getSubscriptionInvoiceByUID */
  async getSubscriptionInvoiceByUID(invoiceUID: number, orgUID: number): Promise<Row | null> {
    const row = (await erpKnexRead("Billing.SubscriptionInvoicesTbl as SI")
      .join("Billing.SubscriptionOrdersTbl as SO", "SO.OrderUID", "SI.OrderUID")
      .select("SI.InvoiceNumber", "SI.PDFPath")
      .where({ "SI.InvoiceUID": invoiceUID, "SO.OrgUID": orgUID })
      .first()) as Row | undefined;
    return row ?? null;
  }

  /** BillingPlan_model::getOrgByUID (for public renew page) */
  async getOrgByUID(orgUID: number): Promise<Row | null> {
    const row = (await erpKnexRead("Organisation.OrganisationTbl")
      .select("OrgUID", "Name", "EmailAddress", "SectorUID", "Logo")
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .first()) as Row | undefined;
    return row ?? null;
  }

  /** Get the first (admin) role UID for an org. */
  async getFirstAdminRoleUID(orgUID: number): Promise<number> {
    const row = (await erpKnexRead("UserRole.RolesTbl")
      .select("RoleUID")
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("RoleUID", "asc")
      .first()) as Row | undefined;
    return row ? toInt(row.RoleUID) : 0;
  }

  /* BillingPlan_model::activateScheduledPlan — called from middleware when ScheduledStartDate is due. */
  async activateScheduledPlan(scheduledChangeUID: number, orgUID: number): Promise<{ Error: boolean; Message: string }> {
    const sc = (await erpKnexRead("Billing.ScheduledPlanChangeTbl")
      .select("*")
      .where({ ScheduledChangeUID: scheduledChangeUID, OrgUID: orgUID, Status: "Pending" })
      .first()) as Row | undefined;

    if (!sc) return { Error: true, Message: "Scheduled change not found or already activated." };

    const plan = (await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select("SP.PlanName")
      .where({ "SPT.SectorPlanUID": toInt(sc.NewSectorPlanUID) })
      .first()) as Row | undefined;

    if (!plan) return { Error: true, Message: "Scheduled plan no longer available." };

    const now              = new Date().toISOString().replace("T", " ").slice(0, 19);
    const startDt          = String(sc.ScheduledStartDate) + " 00:00:00";
    const endDt            = String(sc.ScheduledEndDate)   + " 23:59:59";
    const fyValue          = billingFy("long");
    const createdBy        = toInt(sc.CreatedBy ?? 0);
    const newSectorPlanUID = toInt(sc.NewSectorPlanUID);

    await erpKnexWrite.transaction(async (trx) => {
      /* 1. Supersede existing active subscription */
      await trx.raw(
        "UPDATE Billing.OrgSubscriptionTbl SET Status='Superseded', UpdatedBy=?, UpdatedOn=?, ClosedOn=? WHERE OrgUID=? AND Status NOT IN ('Cancelled', 'Superseded')",
        [createdBy || null, now, now, orgUID]
      );

      /* 2. Insert new subscription row */
      const [newOrgSubUID] = await trx("Billing.OrgSubscriptionTbl").insert({
        OrgUID:        orgUID,
        SectorPlanUID: newSectorPlanUID,
        FinancialYear: fyValue,
        StartDate:     startDt,
        EndDate:       endDt,
        Status:        "Active",
        CreatedBy:     createdBy || null,
        CreatedOn:     now,
        UpdatedBy:     createdBy || null,
        UpdatedOn:     now,
      });

      /* 3. Link order row to the new OrgSubUID */
      if (sc.OrderUID) {
        await trx("Billing.SubscriptionOrdersTbl")
          .where({ OrderUID: toInt(sc.OrderUID) })
          .update({ OrgSubUID: newOrgSubUID });
      }

      /* 4. Mark the scheduled change as activated */
      await trx("Billing.ScheduledPlanChangeTbl")
        .where({ ScheduledChangeUID: scheduledChangeUID })
        .update({ Status: "Activated", UpdatedBy: createdBy || null, UpdatedOn: now, ActivatedOn: now });
    });

    /* 5. Apply menu/module filter — outside transaction (touches cache + multiple DB tables) */
    await this.billingOps.applyPlanMenuFilter(orgUID, newSectorPlanUID).catch((err: unknown) =>
      TelegramNotifier.error("BillingPlanService::activateScheduledPlan applyPlanMenuFilter", err, { orgUID, scheduledChangeUID })
    );

    return { Error: false, Message: `Scheduled plan activated: ${String(plan.PlanName)}` };
  }

  /* Called from Middleware.php on every non-AJAX page load — checks for a due pending plan change
     and activates it, replacing the two-step DB query + activateScheduledPlan call in CI3. */
  async checkAndActivateScheduledPlan(orgUID: number): Promise<{ triggered: boolean; Message: string }> {
    if (orgUID <= 0) return { triggered: false, Message: "No org." };

    const sc = (await erpKnexRead("Billing.ScheduledPlanChangeTbl")
      .select("ScheduledChangeUID")
      .where({ OrgUID: orgUID, Status: "Pending" })
      .where("ScheduledStartDate", "<=", new Date().toISOString().slice(0, 10))
      .orderBy("ScheduledStartDate", "asc")
      .first()) as Row | undefined;

    if (!sc) return { triggered: false, Message: "No pending scheduled plan." };

    const result = await this.activateScheduledPlan(toInt(sc.ScheduledChangeUID), orgUID);
    return { triggered: !result.Error, Message: result.Message };
  }
}
