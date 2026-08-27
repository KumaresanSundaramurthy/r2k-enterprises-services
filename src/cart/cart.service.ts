import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CartItem, CartRepository } from "./cart.repository";
import { ProductsRepository } from "../products/products.repository";
import { AddToCartDto } from "./dto/add-to-cart.dto";
import { UpdateCartItemDto } from "./dto/update-cart-item.dto";

function findItemIndex(items: CartItem[], productId: number, variantId: number | null): number {
  return items.findIndex((item) => item.productId === productId && item.variantId === variantId);
}

@Injectable()
export class CartService {
  constructor(
    private readonly cartRepository: CartRepository,
    private readonly productsRepository: ProductsRepository
  ) {}

  async getCart(userUID: number) {
    const cart = await this.cartRepository.getCartByUser(userUID);
    return { cart: cart || { userUID, items: [] } };
  }

  async addToCart(userUID: number, orgUID: number, dto: AddToCartDto) {
    const product = await this.productsRepository.getProductById(orgUID, dto.productId);
    if (!product) {
      throw new NotFoundException("Product not found");
    }

    if (product.variants.length > 0 && !dto.variantId) {
      throw new BadRequestException("This product requires selecting a variant");
    }

    let price = product.basePrice;
    let brand: string | null = null;
    let size: string | null = null;
    let resolvedVariantId: number | null = null;

    if (dto.variantId) {
      const variant = product.variants.find((v) => v.variantUID === dto.variantId);
      if (!variant) {
        throw new NotFoundException("Variant not found for this product");
      }
      price = variant.price;
      brand = variant.brand;
      size = variant.size;
      resolvedVariantId = variant.variantUID;
    }

    let cart = await this.cartRepository.getCartByUser(userUID);
    if (!cart) {
      cart = await this.cartRepository.createCart(userUID);
    }

    const items = [...cart.items];
    const existingIndex = findItemIndex(items, dto.productId, resolvedVariantId);
    if (existingIndex >= 0) {
      items[existingIndex] = {
        ...items[existingIndex],
        quantity: items[existingIndex].quantity + dto.quantity,
        price,
        name: product.name,
        brand,
        size,
        imageUrl: product.imageUrl,
      };
    } else {
      items.push({
        productId: dto.productId,
        variantId: resolvedVariantId,
        name: product.name,
        brand,
        size,
        imageUrl: product.imageUrl,
        quantity: dto.quantity,
        price,
      });
    }

    await this.cartRepository.saveCartItems(userUID, items);
    return { cart: { ...cart, items } };
  }

  async updateCartItem(userUID: number, dto: UpdateCartItemDto) {
    const cart = await this.cartRepository.getCartByUser(userUID);
    if (!cart) {
      throw new NotFoundException("Cart not found");
    }

    const items = [...cart.items];
    const index = findItemIndex(items, dto.productId, dto.variantId ?? null);
    if (index < 0) {
      throw new NotFoundException("Item not in cart");
    }

    items[index] = { ...items[index], quantity: dto.quantity };
    await this.cartRepository.saveCartItems(userUID, items);
    return { cart: { ...cart, items } };
  }

  async removeFromCart(userUID: number, productId: number, variantId: number | null) {
    const cart = await this.cartRepository.getCartByUser(userUID);
    if (!cart) {
      throw new NotFoundException("Cart not found");
    }

    const items = cart.items.filter((item) => !(item.productId === productId && item.variantId === variantId));
    await this.cartRepository.saveCartItems(userUID, items);
    return { cart: { ...cart, items } };
  }
}
