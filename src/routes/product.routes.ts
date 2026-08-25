import { Router } from "express";
import {
  listProducts,
  listCategories,
  listVendors,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/product.controller";
import { asyncHandler } from "../utils/asyncHandler";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * tags:
 *   name: Products
 *   description: Product catalog browsing and management (MySQL-backed, scoped to the caller's organisation)
 */

/**
 * @openapi
 * /api/products:
 *   get:
 *     tags: [Products]
 *     summary: List products for the caller's organisation
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Category name
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Case-insensitive match on product name
 *       - in: query
 *         name: vendor
 *         schema: { type: string }
 *         description: Brand name (products are matched via their variants' brand)
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [newest, price_asc, price_desc, name_asc]
 *     responses:
 *       200:
 *         description: List of products
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 products:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ProductListItem'
 *       401:
 *         description: Not authenticated
 *   post:
 *     tags: [Products]
 *     summary: Create a product (admin only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, price, stock]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               price: { type: number }
 *               mrp: { type: number }
 *               stock: { type: number }
 *               categoryUID: { type: number }
 *     responses:
 *       201:
 *         description: Product created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 product:
 *                   $ref: '#/components/schemas/ProductDetail'
 *       400:
 *         description: Missing required fields
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not an admin
 */
router.get("/", asyncHandler(listProducts));

/**
 * @openapi
 * /api/products/meta/categories:
 *   get:
 *     tags: [Products]
 *     summary: List active categories for the caller's organisation
 *     responses:
 *       200:
 *         description: List of categories
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       categoryUID: { type: number }
 *                       name: { type: string }
 *       401:
 *         description: Not authenticated
 */
router.get("/meta/categories", asyncHandler(listCategories));

/**
 * @openapi
 * /api/products/meta/vendors:
 *   get:
 *     tags: [Products]
 *     summary: List brands in use across the organisation's product variants
 *     responses:
 *       200:
 *         description: List of brands
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vendors:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       brandUID: { type: number }
 *                       name: { type: string }
 *       401:
 *         description: Not authenticated
 */
router.get("/meta/vendors", asyncHandler(listVendors));

/**
 * @openapi
 * /api/products/{id}:
 *   get:
 *     tags: [Products]
 *     summary: Get the complete record for a product by id and organisation
 *     description: >
 *       Returns every ProductTbl column (with FK names resolved for category, storage, tax,
 *       unit and discount type) plus its variants (with per-variant stock), brand-level stock
 *       breakdown, and all image attachments.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: ProductUID
 *       - in: query
 *         name: orgId
 *         required: true
 *         schema: { type: integer }
 *         description: OrgUID that owns the product
 *     responses:
 *       200:
 *         description: Product found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 product:
 *                   $ref: '#/components/schemas/ProductFullDetail'
 *       400:
 *         description: productId or orgId missing/invalid
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Product not found
 *   put:
 *     tags: [Products]
 *     summary: Update a product's base fields and/or stock (admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               price: { type: number }
 *               mrp: { type: number }
 *               stock: { type: number }
 *               categoryUID: { type: number }
 *     responses:
 *       200:
 *         description: Product updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 product:
 *                   $ref: '#/components/schemas/ProductDetail'
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not an admin
 *       404:
 *         description: Product not found
 *   delete:
 *     tags: [Products]
 *     summary: Soft-delete a product (admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Product deleted
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not an admin
 *       404:
 *         description: Product not found
 */
router.get("/:id", asyncHandler(getProduct));
router.post("/", requireAdmin, asyncHandler(createProduct));
router.put("/:id", requireAdmin, asyncHandler(updateProduct));
router.delete("/:id", requireAdmin, asyncHandler(deleteProduct));

export default router;
