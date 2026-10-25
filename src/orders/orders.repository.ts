import { Injectable } from "@nestjs/common";
import { knexRead, knexWrite } from "../config/knex";

export type OrderStatus = "pending" | "confirmed" | "shipped" | "delivered" | "cancelled";
export type PaymentMethod = "cod" | "razorpay";
export type PaymentStatus = "pending" | "paid" | "failed";

export interface OrderItem {
  productId: number;
  variantId: number | null;
  name: string;
  brand: string | null;
  size: string | null;
  quantity: number;
  price: number;
}

export interface ShippingAddress {
  fullName: string;
  addressLine: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
}

export interface OrderRecord {
  orderUID: number;
  userUID: number;
  orgUID: number;
  items: OrderItem[];
  shippingAddress: ShippingAddress;
  totalAmount: number;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  createdOn: Date;
  updatedOn: Date;
  userName?: string;
  userEmail?: string;
}

interface OrderTblRow {
  OrderUID: number;
  UserUID: number;
  OrgUID: number;
  Items: OrderItem[];
  ShippingAddress: ShippingAddress;
  TotalAmount: number;
  Status: OrderStatus;
  PaymentMethod: PaymentMethod;
  PaymentStatus: PaymentStatus;
  RazorpayOrderId: string | null;
  RazorpayPaymentId: string | null;
  CreatedOn: Date;
  UpdatedOn: Date;
  userName?: string;
  userEmail?: string;
}

function mapRow(row: OrderTblRow): OrderRecord {
  return {
    orderUID: row.OrderUID,
    userUID: row.UserUID,
    orgUID: row.OrgUID,
    items: row.Items,
    shippingAddress: row.ShippingAddress,
    totalAmount: Number(row.TotalAmount),
    status: row.Status,
    paymentMethod: row.PaymentMethod,
    paymentStatus: row.PaymentStatus,
    razorpayOrderId: row.RazorpayOrderId,
    razorpayPaymentId: row.RazorpayPaymentId,
    createdOn: row.CreatedOn,
    updatedOn: row.UpdatedOn,
    ...(row.userName !== undefined ? { userName: row.userName, userEmail: row.userEmail } : {}),
  };
}

export interface CreateOrderInput {
  userUID: number;
  orgUID: number;
  items: OrderItem[];
  shippingAddress: ShippingAddress;
  totalAmount: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
}

@Injectable()
export class OrdersRepository {
  async createOrder(input: CreateOrderInput): Promise<OrderRecord> {
    const [orderUID] = await knexWrite<OrderTblRow>("OrderTbl").insert({
      UserUID: input.userUID,
      OrgUID: input.orgUID,
      Items: JSON.stringify(input.items) as unknown as OrderItem[],
      ShippingAddress: JSON.stringify(input.shippingAddress) as unknown as ShippingAddress,
      TotalAmount: input.totalAmount,
      PaymentMethod: input.paymentMethod,
      PaymentStatus: input.paymentStatus,
      RazorpayOrderId: input.razorpayOrderId ?? null,
      RazorpayPaymentId: input.razorpayPaymentId ?? null,
    });
    const order = await this.findOrderById(orderUID);
    if (!order) throw new Error("Failed to load created order");
    return order;
  }

  async findOrderById(orderUID: number): Promise<OrderRecord | null> {
    const row = await knexRead<OrderTblRow>("OrderTbl").where({ OrderUID: orderUID }).first();
    return row ? mapRow(row) : null;
  }

  async findOrderByIdForUser(orderUID: number, userUID: number): Promise<OrderRecord | null> {
    const row = await knexRead<OrderTblRow>("OrderTbl").where({ OrderUID: orderUID, UserUID: userUID }).first();
    return row ? mapRow(row) : null;
  }

  async findOrdersByUser(userUID: number): Promise<OrderRecord[]> {
    const rows = await knexRead<OrderTblRow>("OrderTbl").where({ UserUID: userUID }).orderBy("CreatedOn", "desc");
    return rows.map(mapRow);
  }

  async findAllOrders(status?: OrderStatus): Promise<OrderRecord[]> {
    const query = knexRead<OrderTblRow>({ o: "OrderTbl" })
      .select("o.*", { userName: "u.Name", userEmail: "u.Email" })
      .leftJoin({ u: "UserTbl" }, "u.UserUID", "o.UserUID")
      .orderBy("o.CreatedOn", "desc");

    if (status) {
      query.andWhere("o.Status", status);
    }

    const rows = await query;
    return rows.map(mapRow);
  }

  async updateOrderStatus(orderUID: number, status: OrderStatus): Promise<OrderRecord | null> {
    await knexWrite("OrderTbl").where({ OrderUID: orderUID }).update({ Status: status });
    return this.findOrderById(orderUID);
  }
}
