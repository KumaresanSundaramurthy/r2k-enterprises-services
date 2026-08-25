import { Request, Response } from "express";
import * as orderRepo from "../repositories/order.repository";
import { placeOrderFromCart } from "../services/order.service";

const VALID_STATUSES: orderRepo.OrderStatus[] = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

export async function createOrder(req: Request, res: Response): Promise<void> {
  const { shippingAddress } = req.body as { shippingAddress: orderRepo.ShippingAddress };

  if (!shippingAddress) {
    res.status(400).json({ message: "shippingAddress is required" });
    return;
  }

  try {
    const order = await placeOrderFromCart({
      userId: req.user!.userId,
      orgUID: req.user!.orgUID,
      shippingAddress,
      paymentMethod: "cod",
      paymentStatus: "pending",
    });
    res.status(201).json({ order });
  } catch (err) {
    res.status(400).json({ message: err instanceof Error ? err.message : "Failed to place order" });
  }
}

export async function listMyOrders(req: Request, res: Response): Promise<void> {
  const orders = await orderRepo.findOrdersByUser(req.user!.userId);
  res.status(200).json({ orders });
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const orderUID = Number(req.params.id);
  const order = await orderRepo.findOrderByIdForUser(orderUID, req.user!.userId);
  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }
  res.status(200).json({ order });
}

export async function listAllOrders(req: Request, res: Response): Promise<void> {
  const { status } = req.query as { status?: orderRepo.OrderStatus };
  const orders = await orderRepo.findAllOrders(status);
  res.status(200).json({ orders });
}

export async function updateOrderStatus(req: Request, res: Response): Promise<void> {
  const { status } = req.body as { status: orderRepo.OrderStatus };

  if (!status || !VALID_STATUSES.includes(status)) {
    res.status(400).json({ message: `status must be one of: ${VALID_STATUSES.join(", ")}` });
    return;
  }

  const orderUID = Number(req.params.id);
  const order = await orderRepo.updateOrderStatus(orderUID, status);
  if (!order) {
    res.status(404).json({ message: "Order not found" });
    return;
  }
  res.status(200).json({ order });
}
