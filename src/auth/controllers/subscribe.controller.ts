import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess, CiValidationError } from "../../core/response/ci-response";
import { toInt } from "../../common/utils/php-compat";
import { TelegramNotifier } from "../../libraries/telegram/telegram-notifier";
import { RedisService } from "../../common/redis/redis.service";
import { SessionService } from "../services/session.service";
import { SubscriptionBillingService } from "../services/subscription-billing.service";
import { ErpSessionPayload, ErpSessionContext } from "../interfaces/erp-session.interface";
import { erpKnexWrite } from "../../config/erp-knex";
import { randomBytes } from "crypto";
import { billingFy, calcPlanEndDate } from "../../core/utils/billing-fy";

class PreparePaymentDto {
  @Allow() sectorPlanUID!: number;
}

class ChangePlanDto {
  @Allow() sectorPlanUID!: number;
}

/** Browser-direct plan selection endpoints — called from subscribe view JS before & after payment. */
@ApiTags("Subscribe")
@ApiBearerAuth()
@Controller("api/subscribe")
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
export class SubscribeController {
  constructor(
    private readonly redis: RedisService,
    private readonly session: SessionService,
    private readonly billingOps: SubscriptionBillingService
  ) {}

  /** Return available plans for the user's org — called directly from the subscribe page browser JS. */
  @Get("availablePlans")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Available plans for the logged-in user's org sector" })
  async availablePlans(@Req() req: Request) {
    const { session } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const plans = await this.billingOps.getAvailablePlansForOrg(orgUID);
    return ciSuccess({ Data: plans });
  }

  /** Store payment intent token in Redis; return redirect URL to checkout page. */
  @Post("preparePayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Validate plan, store sub_pay token in Redis, return checkout redirect URL" })
  async preparePayment(@Body() dto: PreparePaymentDto, @Req() req: Request) {
    const { session } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const sectorPlanUID = toInt(dto.sectorPlanUID);

    if (sectorPlanUID <= 0) throw new CiValidationError("Please select a plan.");

    const flow = this._resolveFlow(String(session.Subscription?.Status ?? ""));

    const plan = await this.billingOps.getSectorPlan(sectorPlanUID);
    if (!plan) throw new CiValidationError("Plan not found.");
    if (Number(plan.Price) <= 0) throw new CiValidationError("Free plan does not require payment.");

    const token = randomBytes(16).toString("hex");
    await this.redis.set(
      `sub_pay_${orgUID}_${token}`,
      { org_uid: orgUID, sector_plan_uid: sectorPlanUID, flow, back_url: "subscribe" },
      86400
    );

    return ciSuccess({ Redirect: `/billing/checkout?t=${token}` });
  }

  /** Update plan selection in DB + Redis; for free plan, activates immediately and returns redirect. */
  @Post("changePlan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Update subscription plan in DB and Redis; activate free plan immediately" })
  async changePlan(@Body() dto: ChangePlanDto, @Req() req: Request) {
    const { session, sessionKey } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const userUID = toInt(session.User.UserUID);
    const newPlanUID = toInt(dto.sectorPlanUID);

    if (newPlanUID <= 0) throw new CiValidationError("Please select a plan.");

    const flow = this._resolveFlow(String(session.Subscription?.Status ?? ""));

    const plan = await this.billingOps.getSectorPlan(newPlanUID);
    if (!plan) throw new CiValidationError("Plan not found.");

    const sub = await this.billingOps.getOrgSubUID(orgUID);
    const isPaid = Number(plan.Price) > 0;
    const endDate = calcPlanEndDate(toInt(plan.DurationDays));

    /* 1. Update subscription row */
    const subUpdate: Record<string, unknown> = { SectorPlanUID: newPlanUID, EndDate: endDate };
    if (flow === "signup") subUpdate.Status = isPaid ? "PendingPayment" : "Active";
    else if (!isPaid) subUpdate.Status = "Active";

    if (sub) {
      await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgSubUID: sub.OrgSubUID }).update(subUpdate);
    }

    /* 2. For signup flow: update or create the SubscriptionOrdersTbl row */
    let orderUID = 0;
    if (flow === "signup" && sub) {
      const existingOrderUID = sub.OrderUID ?? 0;
      const orderData = {
        SectorPlanUID: newPlanUID,
        RenewalType: isPaid ? "New" : "Trial",
        Amount: isPaid ? Number(plan.TaxableAmount) : 0,
        DiscountAmount: 0,
        TaxAmount: isPaid ? Number(plan.TaxAmount) : 0,
        NetAmount: isPaid ? Number(plan.TotalAmount) : 0,
        Status: isPaid ? "Pending" : "Waived",
        IsPaid: isPaid ? 0 : 1,
      };

      if (existingOrderUID > 0) {
        await erpKnexWrite("Billing.SubscriptionOrdersTbl").where({ OrderUID: existingOrderUID }).update(orderData);
        orderUID = existingOrderUID;
      } else {
        const [newOrdUID] = await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
          ...orderData,
          OrgUID: orgUID,
          OrgSubUID: sub.OrgSubUID,
          FinancialYear: billingFy(),
          DueDate: endDate,
          CreatedBy: null,
        });
        orderUID = newOrdUID;
        if (orderUID > 0) {
          await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgSubUID: sub.OrgSubUID }).update({ OrderUID: orderUID });
        }
      }
    }

    /* 3. Update Redis session to reflect new plan + status */
    const loginExpiry = parseInt(process.env.LOGIN_EXPIRE_SECS ?? "86400", 10);
    if (sessionKey && session.Subscription) {
      session.Subscription.SectorPlanUID = newPlanUID;
      session.Subscription.EndDate = endDate;
      if (flow === "signup") session.Subscription.Status = isPaid ? "PendingPayment" : "Active";
      else if (!isPaid) session.Subscription.Status = "Active";
      await this.redis.set(sessionKey, session, loginExpiry);
    }

    /* 4. Free plan: apply menu filter, refresh menu cache, create invoice, clean up order pointer */
    let redirect: string | null = null;
    if (!isPaid) {
      await this.billingOps.applyPlanMenuFilter(orgUID, newPlanUID);

      if (sessionKey) {
        const authHeader = (req.headers.authorization ?? "").replace(/^(bearer\s+)+/i, "").trim();
        const sessionCtx: ErpSessionContext = { key: sessionKey, token: authHeader, data: session };
        await this.session.refreshSession(sessionCtx).catch((err) =>
          TelegramNotifier.error("SubscribeController::changePlan::refreshSession", err, { orgUID, userUID })
        );
      }

      if (orderUID > 0) {
        const hasPayment = await this.billingOps.orderHasPayment(orderUID);
        if (!hasPayment) {
          const now = new Date().toISOString().replace("T", " ").slice(0, 19);
          this.billingOps
            .createPaymentAndInvoice(orgUID, orderUID, plan, "New", "", "", "", "Free", now, "")
            .catch((err) => TelegramNotifier.error("SubscribeController::changePlan::createPaymentAndInvoice", err, { orgUID, orderUID }));
        }
      }

      if (sub) {
        const now = new Date().toISOString().replace("T", " ").slice(0, 19);
        if (orderUID > 0) {
          await erpKnexWrite("Billing.OrgSubscriptionTbl").where({ OrgSubUID: sub.OrgSubUID }).update({ OrderUID: null });
        }
        await erpKnexWrite("Billing.OrgSubscriptionTbl")
          .where({ OrgSubUID: sub.OrgSubUID, FirstPaidOn: null })
          .update({ FirstPaidOn: now });
      }

      redirect = this._redirectForFlow(flow, session);
    }

    return ciSuccess({
      IsFree: !isPaid,
      SectorPlanUID: newPlanUID,
      PlanName: plan.PlanName,
      BillingCycle: plan.BillingCycle,
      Price: Number(plan.Price),
      Redirect: redirect,
    });
  }

  private async _loadSession(req: Request): Promise<{ session: ErpSessionPayload; sessionKey: string }> {
    const claims = (req as Request & { jwtClaims?: { key?: string } }).jwtClaims;
    const sessionKey = claims?.key ?? "";
    const session = sessionKey ? await this.redis.get<ErpSessionPayload>(sessionKey) : null;
    if (!session) throw new Error("Session not found.");
    return { session, sessionKey };
  }

  private _resolveFlow(subStatus: string): "signup" | "renewal" | "upgrade" {
    if (subStatus === "PendingPayment") return "signup";
    if (subStatus === "Expired") return "renewal";
    if (subStatus === "Active") return "upgrade";
    throw new CiValidationError("Invalid subscription state.");
  }

  private _redirectForFlow(flow: string, session: ErpSessionPayload): string {
    if (flow === "upgrade") return "/subscription/dashboard";
    if (flow === "renewal") return "/dashboard";
    return toInt(session.Org?.IsOnboardingComplete ?? 1) === 0 ? "/onboarding" : "/dashboard";
  }
}
