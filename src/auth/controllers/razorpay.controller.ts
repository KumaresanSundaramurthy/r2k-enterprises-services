import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Logger, Param, Post, Req, Res } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { RawBodyRequest } from "@nestjs/common";
import { Request, Response } from "express";
import { Allow } from "class-validator";
import { RazorpayInvoiceService } from "../services/razorpay-invoice.service";

class VerifyPaymentDto {
  @Allow() razorpay_order_id!: string;
  @Allow() razorpay_payment_id!: string;
  @Allow() razorpay_signature!: string;
}

/**
 * Public Razorpay payment endpoints — no JWT required.
 * Security: createOrder/verifyAndRecord are token-scoped; webhook uses HMAC-SHA256.
 */
@ApiTags("Razorpay (public)")
@Controller("api/razorpay")
export class RazorpayController {
  private readonly logger = new Logger(RazorpayController.name);

  constructor(private readonly razorpayInvoice: RazorpayInvoiceService) {}

  @Post("createOrder/:token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Create a Razorpay order for the pending balance on an invoice" })
  async createOrder(@Param("token") token: string): Promise<Record<string, unknown>> {
    try {
      return await this.razorpayInvoice.createInvoiceOrder(token.trim());
    } catch (err: unknown) {
      this.logger.error(`createOrder error: ${err instanceof Error ? err.message : String(err)}`);
      return { Error: true, Message: err instanceof Error ? err.message : "Something went wrong." };
    }
  }

  @Post("verifyAndRecord/:token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify Razorpay signature and record invoice payment in ERP" })
  async verifyAndRecord(
    @Param("token") token: string,
    @Body() body: VerifyPaymentDto
  ): Promise<Record<string, unknown>> {
    try {
      const result = await this.razorpayInvoice.verifyAndRecordInvoicePayment(
        token.trim(),
        String(body.razorpay_order_id ?? ""),
        String(body.razorpay_payment_id ?? ""),
        String(body.razorpay_signature ?? "")
      );
      return result;
    } catch (err: unknown) {
      this.logger.error(`verifyAndRecord error: ${err instanceof Error ? err.message : String(err)}`);
      return { Error: true, Message: err instanceof Error ? err.message : "Something went wrong." };
    }
  }

  @Post("webhook")
  @ApiOperation({ summary: "Razorpay webhook: payment.captured recovery for invoices and subscriptions" })
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers("x-razorpay-signature") signature: string,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ status: string }> {
    const rawBody = req.rawBody;

    if (!rawBody || !this.razorpayInvoice.verifyWebhookSignature(rawBody, signature ?? "")) {
      res.status(HttpStatus.BAD_REQUEST);
      return { status: "invalid_signature" };
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    } catch {
      return { status: "ok" };
    }

    if (String(event.event ?? "") === "payment.captured") {
      try {
        await this.razorpayInvoice.handlePaymentCaptured(event);
      } catch (err: unknown) {
        this.logger.error(`webhook[payment.captured]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { status: "ok" };
  }

  @Get("invoiceInfo/:token")
  @ApiOperation({ summary: "Invoice stub + customer info for the public payment page (no auth required)" })
  async invoiceInfo(@Param("token") token: string): Promise<Record<string, unknown>> {
    if (!token || token.trim().length !== 10) return { Error: true, Message: "Invalid payment link." };
    try {
      const data = await this.razorpayInvoice.getInvoiceInfoForPayPage(token.trim());
      if (!data) return { Error: true, Message: "Invoice not found." };
      return { Error: false, Data: data };
    } catch (err: unknown) {
      this.logger.error(`invoiceInfo error: ${err instanceof Error ? err.message : String(err)}`);
      return { Error: true, Message: "Something went wrong." };
    }
  }
}
