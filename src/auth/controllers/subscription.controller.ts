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
import { RazorpaySubscriptionService } from "../services/razorpay-subscription.service";
import { SubscriptionBillingService } from "../services/subscription-billing.service";
import { BillingPlanService } from "../services/billing-plan.service";
import { ErpSessionPayload, ErpSessionContext } from "../interfaces/erp-session.interface";
import { getRazorpayClient } from "../../config/razorpay";

class GetPlanChangeOptionsDto {
  @Allow() sectorPlanUID!: number;
}

class InitiatePaymentDto {
  @Allow() sectorPlanUID!: number;
  @Allow() amount!: number;
  @Allow() option!: string;
}

class ConfirmPlanChangeDto {
  @Allow() sectorPlanUID!: number;
  @Allow() amount!: number;
  @Allow() option!: string;
  @Allow() razorpay_order_id!: string;
  @Allow() razorpay_payment_id!: string;
  @Allow() razorpay_signature!: string;
  @Allow() scheduled_start?: string;
  @Allow() scheduled_end?: string;
}

class ChangePlanDto {
  @Allow() sectorPlanUID!: number;
}

class RecordPaymentDto {
  @Allow() order_uid!: number;
  @Allow() mode!: string;
  @Allow() amount!: number;
}

class CreateOrderPaymentDto {
  @Allow() order_uid!: number;
}

class ConfirmOrderPaymentDto {
  @Allow() order_uid!: number;
  @Allow() razorpay_order_id!: string;
  @Allow() razorpay_payment_id!: string;
  @Allow() razorpay_signature!: string;
}

/** Browser-direct subscription management endpoints — called from subscription JS views. */
@ApiTags("Subscription")
@ApiBearerAuth()
@Controller("api/subscription")
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
export class SubscriptionController {
  constructor(
    private readonly redis: RedisService,
    private readonly session: SessionService,
    private readonly billingOps: SubscriptionBillingService,
    private readonly billingPlan: BillingPlanService,
    private readonly razorpay: RazorpaySubscriptionService
  ) {}

  /** Plan change options: lock status, scheduled change, billing details, module comparison. */
  @Post("getPlanChangeOptions")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Get lock status, scheduled change, billing details and module diff for a plan change" })
  async getPlanChangeOptions(@Body() dto: GetPlanChangeOptionsDto, @Req() req: Request) {
    const { session } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const newSectorPlanUID = toInt(dto.sectorPlanUID);

    if (newSectorPlanUID <= 0) throw new CiValidationError("Please select a plan.");

    const [lockStatus, scheduledChange, details, modules] = await Promise.all([
      this.billingPlan.getPlanChangeLockStatus(orgUID),
      this.billingPlan.getScheduledPlanChange(orgUID),
      this.billingPlan.calculatePlanChangeDetails(orgUID, newSectorPlanUID),
      this.billingPlan.getModuleComparison(orgUID, newSectorPlanUID),
    ]);

    return ciSuccess({ LockStatus: lockStatus, ScheduledChange: scheduledChange, Details: details, Modules: modules });
  }

  /** Create a Razorpay order for a plan change with the given pro-rated amount. */
  @Post("initiatePayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Create Razorpay order for plan change (custom pro-rated amount)" })
  async initiatePayment(@Body() dto: InitiatePaymentDto, @Req() req: Request) {
    const { session } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const newSectorPlanUID = toInt(dto.sectorPlanUID);
    const amount = Math.round(Number(dto.amount) * 100); // paisa

    if (newSectorPlanUID <= 0) throw new CiValidationError("Please select a plan.");
    if (amount <= 0) throw new CiValidationError("Amount must be greater than zero.");

    const orgName = String(session.Org?.OrgName ?? "");
    const orgEmail = String(session.User?.EmailAddress ?? "");
    const razorpayClient = getRazorpayClient();

    const rpOrder = await razorpayClient.orders.create({
      amount,
      currency: "INR",
      receipt: `plan_${orgUID}_${Date.now()}`,
      notes: { orgUID: String(orgUID), sectorPlanUID: String(newSectorPlanUID), option: dto.option ?? "" },
    } as Parameters<typeof razorpayClient.orders.create>[0]);

    return ciSuccess({
      OrderId: rpOrder.id,
      Amount: rpOrder.amount,
      Currency: rpOrder.currency,
      OrgName: orgName,
      OrgEmail: orgEmail,
      KeyId: process.env.RAZORPAY_KEY_ID ?? "",
    });
  }

  /** Verify Razorpay signature, then apply plan change or schedule it. */
  @Post("confirmPlanChange")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify Razorpay payment and apply or schedule the plan change" })
  async confirmPlanChange(@Body() dto: ConfirmPlanChangeDto, @Req() req: Request) {
    const { session, sessionKey } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const userUID = toInt(session.User.UserUID);
    const newSectorPlanUID = toInt(dto.sectorPlanUID);

    if (newSectorPlanUID <= 0) throw new CiValidationError("Please select a plan.");
    if (!dto.razorpay_order_id || !dto.razorpay_payment_id || !dto.razorpay_signature) {
      throw new CiValidationError("Missing payment credentials.");
    }

    const isValid = this.razorpay.verifySignature(dto.razorpay_order_id, dto.razorpay_payment_id, dto.razorpay_signature);
    if (!isValid) throw new CiValidationError("Payment verification failed. Please contact support.");

    const { paymentMode, bankRrn } = await this.razorpay.fetchPaymentDetails(dto.razorpay_payment_id);
    const adminRoleUID = await this.billingPlan.getFirstAdminRoleUID(orgUID);
    const amount = Number(dto.amount ?? 0);

    const isScheduled = ["UB", "DC"].includes(String(dto.option ?? "").toUpperCase());

    let result: Record<string, unknown>;

    if (isScheduled) {
      if (!dto.scheduled_start || !dto.scheduled_end) throw new CiValidationError("Scheduled dates are required.");
      const changeType = String(dto.option ?? "").toUpperCase() === "UB" ? "Upgrade" : "Downgrade";
      result = await this.billingPlan.schedulePlanChange(
        orgUID, newSectorPlanUID, changeType, String(dto.option ?? "").toUpperCase(),
        dto.scheduled_start, dto.scheduled_end, adminRoleUID, userUID,
        { paid: true, mode: paymentMode, amount, discount: 0, tax: 0, notes: null, paymentId: dto.razorpay_payment_id, gatewayOrderId: dto.razorpay_order_id, gatewaySignature: dto.razorpay_signature }
      );
    } else {
      const details = await this.billingPlan.calculatePlanChangeDetails(orgUID, newSectorPlanUID);
      const changeType = String(details.ChangeType ?? "Upgrade");
      result = await this.billingPlan.changePlan(
        orgUID, newSectorPlanUID, changeType, adminRoleUID, userUID,
        { paid: true, mode: paymentMode, amount, discount: 0, tax: 0, notes: null, paymentId: dto.razorpay_payment_id, gatewayOrderId: dto.razorpay_order_id, gatewaySignature: dto.razorpay_signature }
      );

      await this._refreshSession(sessionKey, session, newSectorPlanUID, String(result.EndDate ?? "")).catch((err: unknown) =>
        TelegramNotifier.error("SubscriptionController::confirmPlanChange::refreshSession", err, { orgUID, userUID })
      );
    }

    return ciSuccess({ ...result, Scheduled: isScheduled });
  }

  /** Admin dashboard: manual plan change (no payment). */
  @Post("changePlan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Admin dashboard manual plan change (no payment required)" })
  async changePlan(@Body() dto: ChangePlanDto, @Req() req: Request) {
    const { session, sessionKey } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const userUID = toInt(session.User.UserUID);
    const newSectorPlanUID = toInt(dto.sectorPlanUID);

    if (newSectorPlanUID <= 0) throw new CiValidationError("Please select a plan.");

    const adminRoleUID = await this.billingPlan.getFirstAdminRoleUID(orgUID);
    const result = await this.billingPlan.changePlan(
      orgUID, newSectorPlanUID, "Manual", adminRoleUID, userUID,
      { paid: false, mode: null, amount: 0, discount: 0, tax: 0, notes: null }
    );

    await this._refreshSession(sessionKey, session, newSectorPlanUID, String(result.EndDate ?? "")).catch((err: unknown) =>
      TelegramNotifier.error("SubscriptionController::changePlan::refreshSession", err, { orgUID, userUID })
    );

    return ciSuccess(result);
  }

  /** Admin dashboard: renew current plan (no payment). */
  @Post("renewPlan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Admin dashboard manual plan renewal (no payment required)" })
  async renewPlan(@Req() req: Request) {
    const { session, sessionKey } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const userUID = toInt(session.User.UserUID);

    const sub = await this.billingPlan.getOrgSubscription(orgUID);
    if (!sub || !sub.SectorPlanUID) throw new CiValidationError("No active subscription found.");

    const curSectorPlanUID = toInt(sub.SectorPlanUID);
    const adminRoleUID = await this.billingPlan.getFirstAdminRoleUID(orgUID);
    const result = await this.billingPlan.changePlan(
      orgUID, curSectorPlanUID, "Renewal", adminRoleUID, userUID,
      { paid: false, mode: null, amount: 0, discount: 0, tax: 0, notes: null }
    );

    await this._refreshSession(sessionKey, session, curSectorPlanUID, String(result.EndDate ?? "")).catch((err: unknown) =>
      TelegramNotifier.error("SubscriptionController::renewPlan::refreshSession", err, { orgUID, userUID })
    );

    return ciSuccess(result);
  }

  /** Record a manual payment against a pending subscription order. */
  @Post("recordPayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record manual payment on a pending subscription order" })
  async recordPayment(@Body() dto: RecordPaymentDto, @Req() req: Request) {
    const { session } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const orderUID = toInt(dto.order_uid);
    const amount = Number(dto.amount ?? 0);
    const mode = String(dto.mode ?? "").trim();

    if (orderUID <= 0) throw new CiValidationError("Invalid order.");
    if (amount <= 0) throw new CiValidationError("Amount must be greater than zero.");
    if (!mode) throw new CiValidationError("Payment mode is required.");

    await this.billingPlan.recordPayment(orgUID, orderUID, mode, amount);
    return ciSuccess({ ok: true });
  }

  /** Create a Razorpay order for an existing pending subscription order. */
  @Post("createOrderPayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Create Razorpay order for an existing pending subscription order" })
  async createOrderPayment(@Body() dto: CreateOrderPaymentDto, @Req() req: Request) {
    const { session } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const orderUID = toInt(dto.order_uid);

    if (orderUID <= 0) throw new CiValidationError("Invalid order.");

    const orderRow = await this.billingPlan.getPendingOrder(orgUID, orderUID);
    if (!orderRow) throw new CiValidationError("Pending order not found.");

    const amount = Math.round(Number(orderRow.NetAmount ?? 0) * 100); // paisa
    if (amount <= 0) throw new CiValidationError("Order amount must be greater than zero.");

    const razorpayClient = getRazorpayClient();
    const rpOrder = await razorpayClient.orders.create({
      amount,
      currency: "INR",
      receipt: `ord_${orgUID}_${orderUID}`,
      notes: { orgUID: String(orgUID), orderUID: String(orderUID) },
    } as Parameters<typeof razorpayClient.orders.create>[0]);

    return ciSuccess({
      OrderId: rpOrder.id,
      Amount: rpOrder.amount,
      Currency: rpOrder.currency,
      OrgName: String(session.Org?.OrgName ?? ""),
      OrgEmail: String(session.User?.EmailAddress ?? ""),
      KeyId: process.env.RAZORPAY_KEY_ID ?? "",
      SubscriptionOrderUID: orderUID,
    });
  }

  /** Verify Razorpay payment for a pending order and trigger invoice generation. */
  @Post("confirmOrderPayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify Razorpay payment for pending order, mark paid, and fire invoice" })
  async confirmOrderPayment(@Body() dto: ConfirmOrderPaymentDto, @Req() req: Request) {
    const { session } = await this._loadSession(req);
    const orgUID = toInt(session.Org.OrgUID);
    const orderUID = toInt(dto.order_uid);

    if (orderUID <= 0) throw new CiValidationError("Invalid order.");
    if (!dto.razorpay_order_id || !dto.razorpay_payment_id || !dto.razorpay_signature) {
      throw new CiValidationError("Missing payment credentials.");
    }

    const isValid = this.razorpay.verifySignature(dto.razorpay_order_id, dto.razorpay_payment_id, dto.razorpay_signature);
    if (!isValid) throw new CiValidationError("Payment verification failed. Please contact support.");

    const hasPayment = await this.billingOps.orderHasPayment(orderUID);
    if (hasPayment) return ciSuccess({ ok: true, Message: "Payment already recorded." });

    const orderRow = await this.billingPlan.getPendingOrder(orgUID, orderUID);
    if (!orderRow) throw new CiValidationError("Order not found.");

    const { paymentMode, bankRrn } = await this.razorpay.fetchPaymentDetails(dto.razorpay_payment_id);
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const plan = await this.billingOps.getSectorPlan(toInt(orderRow.SectorPlanUID));

    if (!plan) throw new CiValidationError("Plan not found for this order.");

    /* Mark order as paid */
    const { erpKnexWrite } = await import("../../config/erp-knex");
    await erpKnexWrite("Billing.SubscriptionOrdersTbl")
      .where({ OrderUID: orderUID })
      .update({ Status: "Paid", IsPaid: 1, PaidOn: now, PaymentMode: paymentMode });

    /* Fire-and-forget invoice */
    this.billingOps
      .createPaymentAndInvoice(orgUID, orderUID, plan, String(orderRow.RenewalType ?? "Renewal"), dto.razorpay_order_id, dto.razorpay_payment_id, dto.razorpay_signature, paymentMode, now, bankRrn)
      .catch((err: unknown) => TelegramNotifier.error("SubscriptionController::confirmOrderPayment", err, { orgUID, orderUID }));

    return ciSuccess({ ok: true });
  }

  /* ── Dashboard data endpoints (browser-facing, CiJwtGuard) ── */

  /**
   * Current org subscription row — called from subscription dashboard on page load.
   * @returns Subscription row or null
   */
  @Get("myPlan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Current org subscription details (dashboard)" })
  async getMyPlan(@Req() req: Request) {
    const { session } = await this._loadSession(req);
    const row = await this.billingPlan.getOrgSubscription(toInt(session.Org.OrgUID));
    return ciSuccess({ Data: row ?? null });
  }

  /**
   * Billing order history for the current org.
   * @returns Last 10 orders with invoice info
   */
  @Get("myOrders")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Org billing order history (dashboard)" })
  async getMyOrders(@Req() req: Request) {
    const { session } = await this._loadSession(req);
    const rows = await this.billingPlan.getOrderHistory(toInt(session.Org.OrgUID), 10);
    return ciSuccess({ Data: rows });
  }

  /**
   * Available subscription plans for the current org's sector.
   * @returns Plan list for the Change Plan modal dropdown
   */
  @Get("myPlans")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Available plans for change-plan modal (dashboard)" })
  async getMyPlans(@Req() req: Request) {
    const { session } = await this._loadSession(req);
    const rows = await this.billingPlan.getAvailablePlans(toInt(session.Org.OrgUID));
    return ciSuccess({ Data: rows });
  }

  private async _loadSession(req: Request): Promise<{ session: ErpSessionPayload; sessionKey: string }> {
    const claims = (req as Request & { jwtClaims?: { key?: string } }).jwtClaims;
    const sessionKey = claims?.key ?? "";
    const session = sessionKey ? await this.redis.get<ErpSessionPayload>(sessionKey) : null;
    if (!session) throw new Error("Session not found.");
    return { session, sessionKey };
  }

  private async _refreshSession(sessionKey: string, session: ErpSessionPayload, newSectorPlanUID: number, endDate: string): Promise<void> {
    const loginExpiry = parseInt(process.env.LOGIN_EXPIRE_SECS ?? "86400", 10);
    if (sessionKey && session.Subscription) {
      session.Subscription.SectorPlanUID = newSectorPlanUID;
      if (endDate) session.Subscription.EndDate = endDate;
      session.Subscription.Status = "Active";
      await this.redis.set(sessionKey, session, loginExpiry);

      const sessionCtx: ErpSessionContext = { key: sessionKey, token: "", data: session };
      await this.session.refreshSession(sessionCtx);
    }
  }
}
