import { Router } from "express";
import { createRazorpayOrder, verifyRazorpayPayment } from "../controllers/payment.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * tags:
 *   name: Payments
 *   description: Razorpay checkout flow
 */

/**
 * @openapi
 * /api/payments/create-order:
 *   post:
 *     tags: [Payments]
 *     summary: Create a Razorpay order for the current cart total
 *     responses:
 *       201:
 *         description: Razorpay order created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 razorpayOrderId: { type: string }
 *                 amount: { type: number, description: "Amount in paise" }
 *                 currency: { type: string, example: INR }
 *                 keyId: { type: string }
 */
router.post("/create-order", asyncHandler(createRazorpayOrder));

/**
 * @openapi
 * /api/payments/verify:
 *   post:
 *     tags: [Payments]
 *     summary: Verify a Razorpay payment signature and place the order
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [razorpay_order_id, razorpay_payment_id, razorpay_signature, shippingAddress]
 *             properties:
 *               razorpay_order_id: { type: string }
 *               razorpay_payment_id: { type: string }
 *               razorpay_signature: { type: string }
 *               shippingAddress:
 *                 $ref: '#/components/schemas/ShippingAddress'
 *     responses:
 *       201:
 *         description: Order created after successful verification
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       400:
 *         description: Missing fields or signature verification failed
 */
router.post("/verify", asyncHandler(verifyRazorpayPayment));

export default router;
