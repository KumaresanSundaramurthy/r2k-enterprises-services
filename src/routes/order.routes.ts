import { Router } from "express";
import {
  createOrder,
  listMyOrders,
  getOrder,
  listAllOrders,
  updateOrderStatus,
} from "../controllers/order.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * tags:
 *   name: Orders
 *   description: Order placement and tracking
 */

/**
 * @openapi
 * /api/orders:
 *   post:
 *     tags: [Orders]
 *     summary: Place a cash-on-delivery order from the current cart
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shippingAddress]
 *             properties:
 *               shippingAddress:
 *                 $ref: '#/components/schemas/ShippingAddress'
 *     responses:
 *       201:
 *         description: Order created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       400:
 *         description: Missing shippingAddress or empty cart
 *   get:
 *     tags: [Orders]
 *     summary: List the current user's orders
 *     responses:
 *       200:
 *         description: List of orders
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orders:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Order'
 */
router.post("/", asyncHandler(createOrder));
router.get("/", asyncHandler(listMyOrders));

/**
 * @openapi
 * /api/orders/admin/all:
 *   get:
 *     tags: [Orders]
 *     summary: List all orders (admin only)
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, confirmed, shipped, delivered, cancelled]
 *     responses:
 *       200:
 *         description: List of all orders
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 orders:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Order'
 *       403:
 *         description: Not an admin
 */
router.get("/admin/all", requireAdmin, asyncHandler(listAllOrders));

/**
 * @openapi
 * /api/orders/{id}/status:
 *   put:
 *     tags: [Orders]
 *     summary: Update an order's status (admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, shipped, delivered, cancelled]
 *     responses:
 *       200:
 *         description: Order updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       400:
 *         description: Invalid status
 *       403:
 *         description: Not an admin
 *       404:
 *         description: Order not found
 */
router.put("/:id/status", requireAdmin, asyncHandler(updateOrderStatus));

/**
 * @openapi
 * /api/orders/{id}:
 *   get:
 *     tags: [Orders]
 *     summary: Get one of the current user's orders by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Order found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 order:
 *                   $ref: '#/components/schemas/Order'
 *       404:
 *         description: Order not found
 */
router.get("/:id", asyncHandler(getOrder));

export default router;
