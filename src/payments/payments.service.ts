import { BadRequestException, Injectable } from "@nestjs/common";
import crypto from "crypto";
import { getRazorpayClient } from "../config/razorpay";
import { OrdersService } from "../orders/orders.service";
import { VerifyPaymentDto } from "./dto/verify-payment.dto";

@Injectable()
export class PaymentsService {
  constructor(private readonly ordersService: OrdersService) {}

  async createRazorpayOrder(userId: number) {
    const totalAmount = await this.ordersService.getCartTotal(userId);

    const razorpay = getRazorpayClient();
    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(totalAmount * 100),
      currency: "INR",
      receipt: `cart_${userId}_${Date.now()}`,
    });

    return {
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    };
  }

  async verifyRazorpayPayment(userId: number, orgUID: number, dto: VerifyPaymentDto) {
    const keySecret = process.env.RAZORPAY_KEY_SECRET as string;
    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${dto.razorpay_order_id}|${dto.razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== dto.razorpay_signature) {
      throw new BadRequestException("Payment verification failed");
    }

    const order = await this.ordersService.placeOrderFromCart({
      userId,
      orgUID,
      shippingAddress: dto.shippingAddress,
      paymentMethod: "razorpay",
      paymentStatus: "paid",
      razorpayOrderId: dto.razorpay_order_id,
      razorpayPaymentId: dto.razorpay_payment_id,
    });

    return { order };
  }
}
