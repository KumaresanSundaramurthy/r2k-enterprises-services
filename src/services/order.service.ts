import * as cartRepo from "../repositories/cart.repository";
import * as orderRepo from "../repositories/order.repository";
import { decrementStock } from "../repositories/product.repository";

interface PlaceOrderOptions {
  userId: number;
  orgUID: number;
  shippingAddress: orderRepo.ShippingAddress;
  paymentMethod: orderRepo.PaymentMethod;
  paymentStatus: orderRepo.PaymentStatus;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
}

export async function placeOrderFromCart(options: PlaceOrderOptions): Promise<orderRepo.OrderRecord> {
  const { userId, orgUID, shippingAddress, paymentMethod, paymentStatus, razorpayOrderId, razorpayPaymentId } =
    options;

  const cart = await cartRepo.getCartByUser(userId);
  if (!cart || cart.items.length === 0) {
    throw new Error("Cart is empty");
  }

  const orderItems = cart.items.map((item) => ({
    productId: item.productId,
    variantId: item.variantId,
    name: item.name,
    brand: item.brand,
    size: item.size,
    quantity: item.quantity,
    price: item.price,
  }));

  const totalAmount = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

  for (const item of cart.items) {
    await decrementStock(orgUID, item.productId, item.quantity);
  }

  const order = await orderRepo.createOrder({
    userUID: userId,
    orgUID,
    items: orderItems,
    shippingAddress,
    totalAmount,
    paymentMethod,
    paymentStatus,
    razorpayOrderId,
    razorpayPaymentId,
  });

  await cartRepo.saveCartItems(userId, []);

  return order;
}

export async function getCartTotal(userId: number): Promise<number> {
  const cart = await cartRepo.getCartByUser(userId);
  if (!cart || cart.items.length === 0) {
    throw new Error("Cart is empty");
  }
  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
