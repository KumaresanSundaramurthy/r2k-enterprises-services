import { Request, Response } from "express";
import crypto from "crypto";
import { getRazorpayClient } from "../config/razorpay";
import { getCartTotal, placeOrderFromCart } from "../services/order.service";
import { ShippingAddress } from "../repositories/order.repository";

export async function createRazorpayOrder(req: Request, res: Response): Promise<void> {
  const totalAmount = await getCartTotal(req.user!.userId);

  const razorpay = getRazorpayClient();
  const razorpayOrder = await razorpay.orders.create({
    amount: Math.round(totalAmount * 100),
    currency: "INR",
    receipt: `cart_${req.user!.userId}_${Date.now()}`,
  });

  res.status(201).json({
    razorpayOrderId: razorpayOrder.id,
    amount: razorpayOrder.amount,
    currency: razorpayOrder.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
  });
}

export async function verifyRazorpayPayment(req: Request, res: Response): Promise<void> {
  const {
    razorpay_order_id: razorpayOrderId,
    razorpay_payment_id: razorpayPaymentId,
    razorpay_signature: razorpaySignature,
    shippingAddress,
  } = req.body as {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
    shippingAddress: ShippingAddress;
  };

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !shippingAddress) {
    res.status(400).json({ message: "Missing payment verification fields" });
    return;
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET as string;
  const expectedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  if (expectedSignature !== razorpaySignature) {
    res.status(400).json({ message: "Payment verification failed" });
    return;
  }

  try {
    const order = await placeOrderFromCart({
      userId: req.user!.userId,
      orgUID: req.user!.orgUID,
      shippingAddress,
      paymentMethod: "razorpay",
      paymentStatus: "paid",
      razorpayOrderId,
      razorpayPaymentId,
    });
    res.status(201).json({ order });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to place order" });
  }
}
