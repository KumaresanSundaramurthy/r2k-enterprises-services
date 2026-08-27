import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { CartRepository } from "../cart/cart.repository";
import { ProductsRepository } from "../products/products.repository";
import { OrdersRepository, OrderStatus, PaymentMethod, PaymentStatus } from "./orders.repository";
import { ShippingAddressDto } from "./dto/shipping-address.dto";

interface PlaceOrderOptions {
  userId: number;
  orgUID: number;
  shippingAddress: ShippingAddressDto;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly ordersRepository: OrdersRepository,
    private readonly cartRepository: CartRepository,
    private readonly productsRepository: ProductsRepository
  ) {}

  async placeOrderFromCart(options: PlaceOrderOptions) {
    const { userId, orgUID, shippingAddress, paymentMethod, paymentStatus, razorpayOrderId, razorpayPaymentId } =
      options;

    const cart = await this.cartRepository.getCartByUser(userId);
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException("Cart is empty");
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
      await this.productsRepository.decrementStock(orgUID, item.productId, item.quantity);
    }

    const order = await this.ordersRepository.createOrder({
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

    await this.cartRepository.saveCartItems(userId, []);

    return order;
  }

  async getCartTotal(userId: number): Promise<number> {
    const cart = await this.cartRepository.getCartByUser(userId);
    if (!cart || cart.items.length === 0) {
      throw new BadRequestException("Cart is empty");
    }
    return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  async createOrder(userId: number, orgUID: number, shippingAddress: ShippingAddressDto) {
    const order = await this.placeOrderFromCart({
      userId,
      orgUID,
      shippingAddress,
      paymentMethod: "cod",
      paymentStatus: "pending",
    });
    return { order };
  }

  async listMyOrders(userId: number) {
    const orders = await this.ordersRepository.findOrdersByUser(userId);
    return { orders };
  }

  async getOrder(userId: number, orderUID: number) {
    const order = await this.ordersRepository.findOrderByIdForUser(orderUID, userId);
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    return { order };
  }

  async listAllOrders(status?: OrderStatus) {
    const orders = await this.ordersRepository.findAllOrders(status);
    return { orders };
  }

  async updateOrderStatus(orderUID: number, status: OrderStatus) {
    const order = await this.ordersRepository.updateOrderStatus(orderUID, status);
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    return { order };
  }
}
