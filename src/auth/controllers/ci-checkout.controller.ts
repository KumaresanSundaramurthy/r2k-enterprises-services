import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { toInt } from "../../common/utils/php-compat";
import { RazorpaySubscriptionService } from "../services/razorpay-subscription.service";
import { SubscriptionCheckoutService } from "../services/subscription-checkout.service";
import { ErpSessionPayload } from "../interfaces/erp-session.interface";
import { RedisService } from "../../common/redis/redis.service";

class CreateSubscriptionOrderDto {
  @Allow() orgId!: number;
  @Allow() userId!: number;
  @Allow() sectorPlanUID!: number;
}

class ConfirmSubscriptionPaymentDto {
  @Allow() orgId!: number;
  @Allow() userId!: number;
  @Allow() sectorPlanUID!: number;
  @Allow() token!: string;
  @Allow() razorpayOrderId!: string;
  @Allow() razorpayPaymentId!: string;
  @Allow() razorpaySignature!: string;
}

/**
 * Browser-direct billing checkout endpoints — called from the billingcheckout view JS with
 * the ERP JWT (Authorization: Bearer <token>), injected by $.ajaxPrefilter in footer_script.php.
 */
@ApiTags("Billing (checkout)")
@ApiBearerAuth()
@Controller("api/billing")
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
export class CiCheckoutController {
  constructor(
    private readonly razorpay: RazorpaySubscriptionService,
    private readonly checkout: SubscriptionCheckoutService,
    private readonly redis: RedisService
  ) {}

  @Post("createSubscriptionOrder")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Create a Razorpay order for a subscription plan — returns order details for the Razorpay checkout widget" })
  async createSubscriptionOrder(@Body() dto: CreateSubscriptionOrderDto, @Req() req: Request) {
    const session = await this._readSession(req);
    const orgName = String(session?.Org?.OrgName ?? "");
    const orgEmail = String(session?.User?.EmailAddress ?? "");

    const result = await this.razorpay.createOrder(toInt(dto.orgId), toInt(dto.sectorPlanUID), orgName, orgEmail);
    return ciSuccess(result);
  }

  @Post("confirmSubscriptionPayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify Razorpay signature, activate subscription, refresh session, and return redirect URL" })
  async confirmSubscriptionPayment(@Body() dto: ConfirmSubscriptionPaymentDto, @Req() req: Request) {
    const result = await this.checkout.confirmPayment({
      orgUID: toInt(dto.orgId),
      sectorPlanUID: toInt(dto.sectorPlanUID),
      token: dto.token ?? "",
      razorpayOrderId: dto.razorpayOrderId ?? "",
      razorpayPaymentId: dto.razorpayPaymentId ?? "",
      razorpaySignature: dto.razorpaySignature ?? "",
      req,
    });
    return ciSuccess(result);
  }

  private async _readSession(req: Request): Promise<ErpSessionPayload | null> {
    const claims = (req as Request & { jwtClaims?: { key?: string } }).jwtClaims;
    if (!claims?.key) return null;
    return this.redis.get<ErpSessionPayload>(claims.key);
  }
}
