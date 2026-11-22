import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiServerGuard } from "../../common/guards/ci-server.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { SubscriptionBillingService, PlanRow } from "../services/subscription-billing.service";
import { SignupService } from "../services/signup.service";
import { SubscriptionCheckoutService } from "../services/subscription-checkout.service";
import { BillingPlanService, ChangePlanPaymentData } from "../services/billing-plan.service";

class ApplyPlanMenuFilterDto {
  @Allow() orgUID!: number;
  @Allow() sectorPlanUID!: number;
}

class CreatePaymentAndInvoiceDto {
  @Allow() orgUID!: number;
  @Allow() orderUID!: number;
  @Allow() plan?: PlanRow;
  @Allow() renewalType?: string;
  @Allow() rpOrderId?: string;
  @Allow() rpPaymentId?: string;
  @Allow() rpSignature?: string;
  @Allow() paymentMode?: string;
  @Allow() now?: string;
  @Allow() bankRrn?: string;
}

class RegisterViaGoogleDto {
  @Allow() email!: string;
  @Allow() sub!: string;
  @Allow() given_name?: string;
  @Allow() family_name?: string;
  @Allow() picture?: string;
  @Allow() locale?: string;
  @Allow() hd?: string;
  @Allow() SectorPlanUID?: number;
}

class ChangePlanServerDto {
  @Allow() orgUID!: number;
  @Allow() newSectorPlanUID!: number;
  @Allow() renewalType!: string;
  @Allow() adminRoleUID!: number;
  @Allow() userUID!: number;
  @Allow() payment!: ChangePlanPaymentData;
}

class ActivateScheduledPlanDto {
  @Allow() scheduledChangeUID!: number;
  @Allow() orgUID!: number;
}

/**
 * CI3 server-to-server billing endpoints — called from CI3 controllers via services_post/services_get
 * with CiServerGuard (the internal SERVICES_SECRET token, not the public JWT).
 * These replace the now-deleted Signup_model PHP methods.
 */
@ApiTags("Billing (CI3 server)")
@ApiBearerAuth()
@Controller("api/billing")
@UseGuards(CiServerGuard)
@UseFilters(CiExceptionFilter)
class CreatePendingOrderDto {
  @Allow() orgUID!: number;
  @Allow() sectorPlanUID!: number;
}

export class CiBillingController {
  constructor(
    private readonly billingOps: SubscriptionBillingService,
    private readonly signup: SignupService,
    private readonly checkout: SubscriptionCheckoutService,
    private readonly billingPlan: BillingPlanService
  ) {}

  @Get("plan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup_model::getSectorPlan — plan row by SectorPlanUID" })
  async getPlan(@Query("sectorPlanUID") sectorPlanUID: string) {
    const plan = await this.billingOps.getSectorPlan(Number(sectorPlanUID ?? 0));
    return ciSuccess({ Data: plan ?? null });
  }

  @Get("orgSub")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup_model::getOrgSubUID — most recent non-cancelled subscription row" })
  async getOrgSub(@Query("orgUID") orgUID: string) {
    const row = await this.billingOps.getOrgSubUID(Number(orgUID ?? 0));
    return ciSuccess({ Data: row ?? null });
  }

  @Get("orgPlanForPayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup_model::getOrgPlanForPayment — subscription row joined with plan details" })
  async getOrgPlanForPayment(@Query("orgUID") orgUID: string, @Query("status") status: string) {
    const row = await this.billingOps.getOrgPlanForPayment(Number(orgUID ?? 0), status ?? "");
    return ciSuccess({ Data: row ?? null });
  }

  @Get("availablePlans")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup_model::getAvailablePlansForOrg — active plans for the org's sector" })
  async getAvailablePlans(@Query("orgUID") orgUID: string) {
    const rows = await this.billingOps.getAvailablePlansForOrg(Number(orgUID ?? 0));
    return ciSuccess(rows);
  }

  @Post("applyPlanMenuFilter")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup_model::applyPlanMenuFilter — batch-update MainMenusTbl/SubMenusTbl/RoleMenusTbl based on plan modules" })
  async applyPlanMenuFilter(@Body() dto: ApplyPlanMenuFilterDto) {
    const result = await this.billingOps.applyPlanMenuFilter(Number(dto.orgUID), Number(dto.sectorPlanUID));
    return ciSuccess(result);
  }

  @Get("orderHasPayment")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup_model::orderHasPayment — true when a payment row already exists for the order" })
  async orderHasPayment(@Query("orderUID") orderUID: string) {
    const hasPayment = await this.billingOps.orderHasPayment(Number(orderUID ?? 0));
    return ciSuccess({ hasPayment });
  }

  @Post("createPaymentAndInvoice")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup_model::createPaymentAndInvoice — insert payment + invoice rows and generate PDF" })
  async createPaymentAndInvoice(@Body() dto: CreatePaymentAndInvoiceDto) {
    await this.billingOps.createPaymentAndInvoice(
      Number(dto.orgUID),
      Number(dto.orderUID),
      dto.plan ?? null,
      dto.renewalType ?? "New",
      dto.rpOrderId ?? "",
      dto.rpPaymentId ?? "",
      dto.rpSignature ?? "",
      dto.paymentMode ?? "Razorpay",
      dto.now ?? "",
      dto.bankRrn ?? ""
    );
    return ciSuccess({ ok: true });
  }

  @Post("createPendingOrder")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup flow: create or update the pending SubscriptionOrdersTbl row before the checkout page renders" })
  async createPendingOrder(@Body() dto: CreatePendingOrderDto) {
    await this.checkout.createPendingOrder(Number(dto.orgUID), Number(dto.sectorPlanUID));
    return ciSuccess({ ok: true });
  }

  @Post("registerViaGoogle")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Signup_model::registerOrganisationViaGoogle — create a new org from a Google OAuth profile (Oauth::_completeOAuthLogin new-account path)" })
  async registerViaGoogle(@Body() dto: RegisterViaGoogleDto) {
    const result = await this.signup.registerOrganisationViaGoogle(
      {
        email: dto.email ?? "",
        sub: dto.sub ?? "",
        given_name: dto.given_name ?? "",
        family_name: dto.family_name ?? "",
        picture: dto.picture ?? "",
        locale: dto.locale ?? "",
        hd: dto.hd ?? "",
      },
      Number(dto.SectorPlanUID ?? 0)
    );
    return ciSuccess({ OrgUID: result.orgUID, IsPaidPlan: result.isPaidPlan });
  }

  /* ── BillingPlan_model proxy endpoints (called from CI3 Subscription controllers) ── */

  @Get("orgSubscription")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::getOrgSubscription — full subscription row with plan details" })
  async getOrgSubscription(@Query("orgUID") orgUID: string) {
    const row = await this.billingPlan.getOrgSubscription(Number(orgUID ?? 0));
    return ciSuccess({ Data: row ?? null });
  }

  @Get("orderHistory")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::getOrderHistory — recent subscription orders" })
  async getOrderHistory(@Query("orgUID") orgUID: string, @Query("limit") limit: string) {
    const rows = await this.billingPlan.getOrderHistory(Number(orgUID ?? 0), Number(limit ?? 20));
    return ciSuccess({ Data: rows });
  }

  @Get("pendingOrder")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::getPendingOrder — single pending order row" })
  async getPendingOrder(@Query("orgUID") orgUID: string, @Query("orderUID") orderUID: string) {
    const row = await this.billingPlan.getPendingOrder(Number(orgUID ?? 0), Number(orderUID ?? 0));
    return ciSuccess({ Data: row ?? null });
  }

  @Get("moduleCountByPlan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::getModuleCountByPlan — module count per plan for a sector" })
  async getModuleCountByPlan(@Query("sectorUID") sectorUID: string) {
    const rows = await this.billingPlan.getModuleCountByPlan(Number(sectorUID ?? 0));
    return ciSuccess({ Data: rows });
  }

  @Get("subscriptionInvoice")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::getSubscriptionInvoiceByUID — invoice row by UID, scoped to org" })
  async getSubscriptionInvoice(@Query("invoiceUID") invoiceUID: string, @Query("orgUID") orgUID: string) {
    const row = await this.billingPlan.getSubscriptionInvoiceByUID(Number(invoiceUID ?? 0), Number(orgUID ?? 0));
    return ciSuccess({ Data: row ?? null });
  }

  @Get("orgByUID")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::getOrgByUID — org row for public renew page" })
  async getOrgByUID(@Query("orgUID") orgUID: string) {
    const row = await this.billingPlan.getOrgByUID(Number(orgUID ?? 0));
    return ciSuccess({ Data: row ?? null });
  }

  @Get("billingAvailablePlans")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::getAvailablePlans — active plans excluding TRIAL, includes SectorUID" })
  async getBillingAvailablePlans(@Query("orgUID") orgUID: string) {
    const rows = await this.billingPlan.getAvailablePlans(Number(orgUID ?? 0));
    return ciSuccess({ Data: rows });
  }

  @Post("changePlan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::changePlan — called from Subscriptionrenew confirmPayment" })
  async serverChangePlan(@Body() dto: ChangePlanServerDto) {
    const result = await this.billingPlan.changePlan(
      Number(dto.orgUID),
      Number(dto.newSectorPlanUID),
      String(dto.renewalType ?? "Renewal"),
      Number(dto.adminRoleUID ?? 0),
      Number(dto.userUID ?? 0),
      dto.payment ?? { paid: false, mode: null, amount: 0, discount: 0, tax: 0, notes: null }
    );
    return ciSuccess(result);
  }

  @Post("activateScheduledPlan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "BillingPlan_model::activateScheduledPlan — trigger a due scheduled plan change (called from middleware)" })
  async activateScheduledPlan(@Body() dto: ActivateScheduledPlanDto) {
    const result = await this.billingPlan.activateScheduledPlan(
      Number(dto.scheduledChangeUID),
      Number(dto.orgUID)
    );
    return ciSuccess(result);
  }

  @Post("checkAndActivateScheduledPlan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Middleware: check ScheduledPlanChangeTbl and activate if due (single call replaces DB query + activateScheduledPlan)" })
  async checkAndActivateScheduledPlan(@Body() dto: { orgUID: number }) {
    const result = await this.billingPlan.checkAndActivateScheduledPlan(Number(dto.orgUID));
    return ciSuccess(result);
  }
}
