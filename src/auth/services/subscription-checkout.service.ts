import { Injectable } from "@nestjs/common";
import { Request } from "express";
import { erpKnexWrite } from "../../config/erp-knex";
import { nowDateTime, toInt } from "../../common/utils/php-compat";
import { RedisService } from "../../common/redis/redis.service";
import { TelegramNotifier } from "../../libraries/telegram/telegram-notifier";
import { CiValidationError } from "../../core/response/ci-response";
import { ErpJwtClaims, ErpSessionContext, ErpSessionPayload } from "../interfaces/erp-session.interface";
import { RazorpaySubscriptionService } from "./razorpay-subscription.service";
import { SubscriptionBillingService } from "./subscription-billing.service";
import { SessionService } from "./session.service";
import { billingFy, calcPlanEndDate } from "../../core/utils/billing-fy";

type Row = Record<string, unknown>;

export interface CheckoutConfirmParams {
  orgUID: number;
  sectorPlanUID: number;
  token: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  req: Request;
}

export interface CheckoutConfirmResult {
  Redirect: string;
  Message: string;
}

@Injectable()
export class SubscriptionCheckoutService {
  constructor(
    private readonly razorpay: RazorpaySubscriptionService,
    private readonly billingOps: SubscriptionBillingService,
    private readonly session: SessionService,
    private readonly redis: RedisService
  ) {}

  /** Signup flow: create or update the pending SubscriptionOrdersTbl row before the payment page renders. */
  async createPendingOrder(orgUID: number, sectorPlanUID: number): Promise<void> {
    const plan = await this.billingOps.getSectorPlan(sectorPlanUID);
    if (!plan || Number(plan.Price) <= 0) throw new Error("Plan not found or zero price.");

    const sub = await this.billingOps.getOrgSubUID(orgUID);
    const orgSubUID = sub?.OrgSubUID ?? null;
    const existingOrderUID = sub?.OrderUID ?? 0;
    const endDate = calcPlanEndDate(toInt(plan.DurationDays));

    const orderData: Row = {
      SectorPlanUID: sectorPlanUID,
      RenewalType: "New",
      Amount: Number(plan.TaxableAmount),
      DiscountAmount: 0.0,
      TaxAmount: Number(plan.TaxAmount),
      NetAmount: Number(plan.TotalAmount),
      Status: "Pending",
      IsPaid: 0,
      DueDate: endDate,
    };

    if (existingOrderUID > 0) {
      await erpKnexWrite("Billing.SubscriptionOrdersTbl").where({ OrderUID: existingOrderUID }).update(orderData);
    } else {
      const [newOrderUID] = await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
        ...orderData,
        OrgUID: orgUID,
        OrgSubUID: orgSubUID,
        FinancialYear: billingFy("long"),
        CreatedBy: null,
      });
      if (newOrderUID > 0 && orgSubUID) {
        await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgSubUID: orgSubUID }).update({ OrderUID: newOrderUID });
      }
    }
  }

  async confirmPayment(params: CheckoutConfirmParams): Promise<CheckoutConfirmResult> {
    const { orgUID, sectorPlanUID, token, razorpayOrderId, razorpayPaymentId, razorpaySignature, req } = params;

    if (!this.razorpay.verifySignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      throw new CiValidationError("Payment verification failed. Contact support if amount was deducted.");
    }

    /* Fetch payment mode from Razorpay — non-fatal */
    let paymentMode = "Razorpay";
    let bankRrn = "";
    try {
      const details = await this.razorpay.fetchPaymentDetails(razorpayPaymentId);
      paymentMode = details.paymentMode;
      bankRrn = details.bankRrn;
    } catch (err) {
      TelegramNotifier.error("SubscriptionCheckoutService::fetchPaymentDetails", err, { orgUID });
    }

    /* Read JWT session to determine flow */
    const jwtClaims = (req as Request & { jwtClaims?: ErpJwtClaims }).jwtClaims;
    const sessionKey = jwtClaims?.key ?? "";
    const sessionData = sessionKey ? await this.redis.get<ErpSessionPayload>(sessionKey) : null;
    const subStatus = sessionData?.Subscription?.Status ?? "";
    const isOnboardingDone = toInt(sessionData?.Org?.IsOnboardingComplete ?? 1);

    const flow: "signup" | "renewal" | "upgrade" =
      subStatus === "Expired" ? "renewal" : subStatus === "Active" ? "upgrade" : "signup";

    /* Fetch plan + orgSub */
    const plan = await this.billingOps.getSectorPlan(sectorPlanUID);
    if (!plan) throw new Error("Plan not found.");

    const sub = await this.billingOps.getOrgSubUID(orgUID);
    if (!sub) throw new Error("Subscription record not found.");

    const { OrgSubUID: orgSubUID, OrderUID: existingOrderUID } = sub;

    /* Apply plan menu filter */
    await this.billingOps.applyPlanMenuFilter(orgUID, sectorPlanUID);

    const now = nowDateTime();
    const endDate = calcPlanEndDate(toInt(plan.DurationDays));
    let resolvedOrderUID = 0;

    if (flow === "signup") {
      await erpKnexWrite("Billing.OrgSubscriptionTbl")
        .where({ OrgSubUID: orgSubUID })
        .update({ Status: "Active", SectorPlanUID: sectorPlanUID, EndDate: endDate });

      if (existingOrderUID && existingOrderUID > 0) {
        await erpKnexWrite("Billing.SubscriptionOrdersTbl")
          .where({ OrderUID: existingOrderUID })
          .update({ RenewalType: "New", Status: "Paid", IsPaid: 1, PaidOn: now, PaymentMode: paymentMode });
        resolvedOrderUID = existingOrderUID;
      } else {
        const [newUID] = await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
          OrgUID: orgUID, SectorPlanUID: sectorPlanUID, OrgSubUID: orgSubUID,
          RenewalType: "New", DueDate: endDate,
          Amount: Number(plan.TaxableAmount), DiscountAmount: 0.0, TaxAmount: Number(plan.TaxAmount), NetAmount: Number(plan.TotalAmount),
          FinancialYear: billingFy("long"), Status: "Paid", IsPaid: 1, PaidOn: now, PaymentMode: paymentMode, CreatedBy: null,
        });
        resolvedOrderUID = newUID;
        if (resolvedOrderUID > 0) {
          await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgSubUID: orgSubUID }).update({ OrderUID: resolvedOrderUID });
        }
      }

    } else if (flow === "renewal") {
      await erpKnexWrite("Billing.OrgSubscriptionTbl")
        .where({ OrgSubUID: orgSubUID })
        .update({ SectorPlanUID: sectorPlanUID, Status: "Active", StartDate: now, EndDate: endDate });

      const [newUID] = await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
        OrgUID: orgUID, SectorPlanUID: sectorPlanUID, OrgSubUID: orgSubUID,
        RenewalType: "Renewal", DueDate: endDate,
        Amount: Number(plan.TaxableAmount), DiscountAmount: 0.0, TaxAmount: Number(plan.TaxAmount), NetAmount: Number(plan.TotalAmount),
        FinancialYear: billingFy("long"), Status: "Paid", IsPaid: 1, PaidOn: now, PaymentMode: paymentMode, CreatedBy: null,
      });
      resolvedOrderUID = newUID;
      await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgSubUID: orgSubUID }).update({ OrderUID: resolvedOrderUID });

    } else {
      /* upgrade */
      const [newUID] = await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
        OrgUID: orgUID, SectorPlanUID: sectorPlanUID, OrgSubUID: orgSubUID,
        RenewalType: "Upgrade", DueDate: now,
        Amount: Number(plan.TaxableAmount), DiscountAmount: 0.0, TaxAmount: Number(plan.TaxAmount), NetAmount: Number(plan.TotalAmount),
        FinancialYear: billingFy("long"), Status: "Paid", IsPaid: 1, PaidOn: now, PaymentMode: paymentMode, CreatedBy: null,
      });
      resolvedOrderUID = newUID;
      await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgSubUID: orgSubUID }).update({ OrderUID: resolvedOrderUID });
    }

    /* Stamp FirstPaidOn on the first ever successful payment */
    await erpKnexWrite("Billing.OrgSubscriptionTbl")
      .where({ OrgSubUID: orgSubUID, FirstPaidOn: null })
      .update({ FirstPaidOn: now });

    /* Clear pending-order pointer — payment is complete */
    await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgSubUID: orgSubUID }).update({ OrderUID: null });

    /* createPaymentAndInvoice — fire-and-forget */
    if (resolvedOrderUID > 0) {
      const renewalTypeMap: Record<string, string> = { signup: "New", renewal: "Renewal", upgrade: "Upgrade" };
      this.billingOps
        .createPaymentAndInvoice(orgUID, resolvedOrderUID, plan, renewalTypeMap[flow] ?? "New", razorpayOrderId, razorpayPaymentId, razorpaySignature, paymentMode, now, bankRrn)
        .catch((err) => TelegramNotifier.error("SubscriptionCheckoutService::createPaymentAndInvoice", err, { orgUID, resolvedOrderUID }));
    }

    /* Delete payment intent Redis token */
    if (token && /^[0-9a-f]{32}$/.test(token)) {
      await this.redis.del(`sub_pay_${orgUID}_${token}`);
    }

    /* Refresh Redis session — picks up new subscription status from DB */
    if (sessionKey && sessionData) {
      const authHeader = (req.headers.authorization ?? "").replace(/^(bearer\s+)+/i, "").trim();
      const sessionContext: ErpSessionContext = { key: sessionKey, token: authHeader, data: sessionData };
      await this.session.refreshSession(sessionContext).catch((err) => {
        TelegramNotifier.error("SubscriptionCheckoutService::refreshSession", err, { orgUID });
      });
    }

    const redirect =
      flow === "upgrade" ? "/subscription/dashboard" :
      flow === "renewal" ? "/dashboard" :
      isOnboardingDone === 0 ? "/onboarding" : "/dashboard";

    return { Redirect: redirect, Message: "Payment verified. Your subscription is now active!" };
  }
}
