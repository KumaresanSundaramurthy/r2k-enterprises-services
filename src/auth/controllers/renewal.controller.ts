import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess, CiValidationError } from "../../core/response/ci-response";
import { toInt } from "../../common/utils/php-compat";
import { TelegramNotifier } from "../../libraries/telegram/telegram-notifier";
import { RedisService } from "../../common/redis/redis.service";
import { RenewalTokenGuard, RenewalContext } from "../guards/renewal-token.guard";
import { RazorpaySubscriptionService } from "../services/razorpay-subscription.service";
import { SubscriptionBillingService } from "../services/subscription-billing.service";
import { BillingPlanService } from "../services/billing-plan.service";
import { randomBytes } from "crypto";

class CreateOrderDto {
  @Allow() sid!: string;
  @Allow() sector_plan_uid!: number;
}

class ConfirmPaymentDto {
  @Allow() sid!: string;
  @Allow() sector_plan_uid!: number;
  @Allow() razorpay_order_id!: string;
  @Allow() razorpay_payment_id!: string;
  @Allow() razorpay_signature!: string;
}

class PrepareCheckoutDto {
  @Allow() sid!: string;
  @Allow() sector_plan_uid!: number;
}

class CancelTokenDto {
  @Allow() sid!: string;
}

/** Public renewal page AJAX endpoints — authenticated via short-lived rnt_ Redis token (no JWT). */
@ApiTags("Renewal")
@Controller("api/renew")
@UseGuards(RenewalTokenGuard)
@UseFilters(CiExceptionFilter)
export class RenewalController {
  constructor(
    private readonly redis: RedisService,
    private readonly razorpay: RazorpaySubscriptionService,
    private readonly billingOps: SubscriptionBillingService,
    private readonly billingPlan: BillingPlanService
  ) {}

  /** Create a Razorpay order for the selected plan. */
  @Post("createOrder")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Create Razorpay order for renewal — authenticated via rnt_ sid token" })
  async createOrder(@Body() dto: CreateOrderDto, @Req() req: Request) {
    const { orgUID } = this._ctx(req);
    const sectorPlanUID = toInt(dto.sector_plan_uid);

    if (sectorPlanUID <= 0) throw new CiValidationError("Please select a plan.");

    const org = await this.billingPlan.getOrgByUID(orgUID);
    if (!org) throw new CiValidationError("Organisation not found.");

    const orgName  = String(org.Name ?? "");
    const orgEmail = String(org.EmailAddress ?? "");

    const result = await this.razorpay.createOrder(orgUID, sectorPlanUID, orgName, orgEmail);
    return ciSuccess({ Error: false, ...result });
  }

  /** Verify Razorpay payment and activate the renewal. */
  @Post("confirmPayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify payment and activate subscription renewal" })
  async confirmPayment(@Body() dto: ConfirmPaymentDto, @Req() req: Request) {
    const { orgUID, redisKey } = this._ctx(req);
    const sectorPlanUID = toInt(dto.sector_plan_uid);

    if (sectorPlanUID <= 0) throw new CiValidationError("Please select a plan.");
    if (!dto.razorpay_order_id || !dto.razorpay_payment_id || !dto.razorpay_signature) {
      throw new CiValidationError("Incomplete payment data. Please try again.");
    }

    const isValid = this.razorpay.verifySignature(dto.razorpay_order_id, dto.razorpay_payment_id, dto.razorpay_signature);
    if (!isValid) throw new CiValidationError("Payment verification failed. If money was deducted, please contact support.");

    const { paymentMode, bankRrn } = await this.razorpay.fetchPaymentDetails(dto.razorpay_payment_id);

    await this.billingPlan.changePlan(
      orgUID, sectorPlanUID, "Renewal", 0, 0,
      {
        paid: true, mode: paymentMode, amount: 0, discount: 0, tax: 0,
        notes: `Razorpay Order: ${dto.razorpay_order_id} | Payment: ${dto.razorpay_payment_id}`,
        paymentId: dto.razorpay_payment_id,
        gatewayOrderId: dto.razorpay_order_id,
        gatewaySignature: dto.razorpay_signature,
      }
    );

    /* Invalidate the renewal token so it cannot be reused */
    await this.redis.del(redisKey).catch((err: unknown) =>
      TelegramNotifier.error("RenewalController::confirmPayment::delToken", err, { orgUID })
    );

    return ciSuccess({ Error: false, Message: "Subscription activated successfully." });
  }

  /** Store a sub_pay token in Redis and return the checkout redirect URL. */
  @Post("prepareCheckout")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Store sub_pay token in Redis, return checkout redirect URL" })
  async prepareCheckout(@Body() dto: PrepareCheckoutDto, @Req() req: Request) {
    const { orgUID, sid } = this._ctx(req);
    const sectorPlanUID = toInt(dto.sector_plan_uid);

    if (sectorPlanUID <= 0) throw new CiValidationError("Please select a plan.");

    const plan = await this.billingOps.getSectorPlan(sectorPlanUID);
    if (!plan) throw new CiValidationError("Selected plan not found.");
    if (Number(plan.Price) <= 0) throw new CiValidationError("Free plan does not require payment.");

    const token    = randomBytes(16).toString("hex");
    const redisKey = `sub_pay_${orgUID}_${token}`;

    await this.redis.set(redisKey, {
      org_uid:         orgUID,
      sector_plan_uid: sectorPlanUID,
      flow:            "renewal",
      back_url:        `subscription/renew?sid=${encodeURIComponent(sid)}`,
    }, 86400);

    return ciSuccess({ Error: false, Redirect: `/billing/checkout?t=${token}` });
  }

  /** Delete the rnt_ token when the user closes the renewal modal. */
  @Post("cancelToken")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Delete rnt_ renewal token on modal close" })
  async cancelToken(@Req() req: Request) {
    const { redisKey } = this._ctx(req);
    await this.redis.del(redisKey);
    return ciSuccess({ Error: false, Message: "Token cancelled." });
  }

  private _ctx(req: Request): RenewalContext {
    const ctx = (req as Request & { renewalContext?: RenewalContext }).renewalContext;
    if (!ctx) throw new Error("Renewal context missing.");
    return ctx;
  }
}
