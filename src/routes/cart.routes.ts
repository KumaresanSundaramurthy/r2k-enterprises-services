import { Router } from "express";
import { getCart, addToCart, updateCartItem, removeFromCart } from "../controllers/cart.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { requireAuth } from "../middleware/auth.middleware";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * tags:
 *   name: Cart
 *   description: Authenticated user's shopping cart
 */

/**
 * @openapi
 * /api/cart:
 *   get:
 *     tags: [Cart]
 *     summary: Get the current user's cart
 *     responses:
 *       200:
 *         description: Cart contents
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cart:
 *                   $ref: '#/components/schemas/Cart'
 *   post:
 *     tags: [Cart]
 *     summary: Add an item to the cart
 *     description: variantId is required when the product has variants (different brand/size options).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId, quantity]
 *             properties:
 *               productId: { type: integer }
 *               variantId: { type: integer }
 *               quantity: { type: number, minimum: 1 }
 *     responses:
 *       200:
 *         description: Updated cart
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cart:
 *                   $ref: '#/components/schemas/Cart'
 *       400:
 *         description: Invalid productId/quantity, or a variant is required but missing
 *       404:
 *         description: Product or variant not found
 *   put:
 *     tags: [Cart]
 *     summary: Update the quantity of an item already in the cart
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [productId, quantity]
 *             properties:
 *               productId: { type: integer }
 *               variantId: { type: integer }
 *               quantity: { type: number, minimum: 1 }
 *     responses:
 *       200:
 *         description: Updated cart
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cart:
 *                   $ref: '#/components/schemas/Cart'
 *       400:
 *         description: Invalid productId or quantity
 *       404:
 *         description: Cart or item not found
 */
router.get("/", asyncHandler(getCart));
router.post("/", asyncHandler(addToCart));
router.put("/", asyncHandler(updateCartItem));

/**
 * @openapi
 * /api/cart/{productId}:
 *   delete:
 *     tags: [Cart]
 *     summary: Remove an item from the cart
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: variantId
 *         schema: { type: integer }
 *         description: Required if the item in the cart was added with a variant
 *     responses:
 *       200:
 *         description: Updated cart
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cart:
 *                   $ref: '#/components/schemas/Cart'
 *       404:
 *         description: Cart not found
 */
router.delete("/:productId", asyncHandler(removeFromCart));

export default router;
