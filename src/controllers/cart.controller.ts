import { Request, Response } from "express";
import * as cartRepo from "../repositories/cart.repository";
import * as productRepo from "../repositories/product.repository";

function findItemIndex(
  items: { productId: number; variantId: number | null }[],
  productId: number,
  variantId: number | null
): number {
  return items.findIndex((item) => item.productId === productId && item.variantId === variantId);
}

export async function getCart(req: Request, res: Response): Promise<void> {
  const userUID = req.user!.userId;
  const cart = await cartRepo.getCartByUser(userUID);
  res.status(200).json({ cart: cart || { userUID, items: [] } });
}

export async function addToCart(req: Request, res: Response): Promise<void> {
  const { productId, variantId, quantity } = req.body as {
    productId: number;
    variantId?: number;
    quantity: number;
  };

  if (!productId || !quantity || quantity < 1) {
    res.status(400).json({ message: "productId and a valid quantity are required" });
    return;
  }

  const orgUID = req.user!.orgUID;
  const product = await productRepo.getProductById(orgUID, productId);
  if (!product) {
    res.status(404).json({ message: "Product not found" });
    return;
  }

  if (product.variants.length > 0 && !variantId) {
    res.status(400).json({ message: "This product requires selecting a variant" });
    return;
  }

  let price = product.basePrice;
  let brand: string | null = null;
  let size: string | null = null;
  let resolvedVariantId: number | null = null;

  if (variantId) {
    const variant = product.variants.find((v) => v.variantUID === variantId);
    if (!variant) {
      res.status(404).json({ message: "Variant not found for this product" });
      return;
    }
    price = variant.price;
    brand = variant.brand;
    size = variant.size;
    resolvedVariantId = variant.variantUID;
  }

  const userUID = req.user!.userId;
  let cart = await cartRepo.getCartByUser(userUID);
  if (!cart) {
    cart = await cartRepo.createCart(userUID);
  }

  const items = [...cart.items];
  const existingIndex = findItemIndex(items, productId, resolvedVariantId);
  if (existingIndex >= 0) {
    items[existingIndex] = {
      ...items[existingIndex],
      quantity: items[existingIndex].quantity + quantity,
      price,
      name: product.name,
      brand,
      size,
      imageUrl: product.imageUrl,
    };
  } else {
    items.push({
      productId,
      variantId: resolvedVariantId,
      name: product.name,
      brand,
      size,
      imageUrl: product.imageUrl,
      quantity,
      price,
    });
  }

  await cartRepo.saveCartItems(userUID, items);
  res.status(200).json({ cart: { ...cart, items } });
}

export async function updateCartItem(req: Request, res: Response): Promise<void> {
  const { productId, variantId, quantity } = req.body as {
    productId: number;
    variantId?: number;
    quantity: number;
  };

  if (!productId || quantity === undefined || quantity < 1) {
    res.status(400).json({ message: "productId and a valid quantity are required" });
    return;
  }

  const userUID = req.user!.userId;
  const cart = await cartRepo.getCartByUser(userUID);
  if (!cart) {
    res.status(404).json({ message: "Cart not found" });
    return;
  }

  const items = [...cart.items];
  const index = findItemIndex(items, productId, variantId ?? null);
  if (index < 0) {
    res.status(404).json({ message: "Item not in cart" });
    return;
  }

  items[index] = { ...items[index], quantity };
  await cartRepo.saveCartItems(userUID, items);
  res.status(200).json({ cart: { ...cart, items } });
}

export async function removeFromCart(req: Request, res: Response): Promise<void> {
  const productId = Number(req.params.productId);
  const variantId = req.query.variantId ? Number(req.query.variantId) : null;

  const userUID = req.user!.userId;
  const cart = await cartRepo.getCartByUser(userUID);
  if (!cart) {
    res.status(404).json({ message: "Cart not found" });
    return;
  }

  const items = cart.items.filter((item) => !(item.productId === productId && item.variantId === variantId));
  await cartRepo.saveCartItems(userUID, items);
  res.status(200).json({ cart: { ...cart, items } });
}
