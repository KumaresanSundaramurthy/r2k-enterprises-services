import { RowDataPacket, ResultSetHeader } from "mysql2";
import { mysqlReadPool, mysqlWritePool } from "../config/mysql";

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

const SELECT = `
  SELECT o.OrderUID AS orderUID, o.UserUID AS userUID, o.OrgUID AS orgUID, o.Items AS items,
         o.ShippingAddress AS shippingAddress, o.TotalAmount AS totalAmount, o.Status AS status,
         o.PaymentMethod AS paymentMethod, o.PaymentStatus AS paymentStatus,
         o.RazorpayOrderId AS razorpayOrderId, o.RazorpayPaymentId AS razorpayPaymentId,
         o.CreatedOn AS createdOn, o.UpdatedOn AS updatedOn
  FROM OrderTbl o
`;

function mapRow(row: RowDataPacket): OrderRecord {
  return {
    orderUID: row.orderUID,
    userUID: row.userUID,
    orgUID: row.orgUID,
    items: row.items,
    shippingAddress: row.shippingAddress,
    totalAmount: Number(row.totalAmount),
    status: row.status,
    paymentMethod: row.paymentMethod,
    paymentStatus: row.paymentStatus,
    razorpayOrderId: row.razorpayOrderId,
    razorpayPaymentId: row.razorpayPaymentId,
    createdOn: row.createdOn,
    updatedOn: row.updatedOn,
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

export async function createOrder(input: CreateOrderInput): Promise<OrderRecord> {
  const [result] = await mysqlWritePool.query<ResultSetHeader>(
    `INSERT INTO OrderTbl
       (UserUID, OrgUID, Items, ShippingAddress, TotalAmount, PaymentMethod, PaymentStatus, RazorpayOrderId, RazorpayPaymentId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.userUID,
      input.orgUID,
      JSON.stringify(input.items),
      JSON.stringify(input.shippingAddress),
      input.totalAmount,
      input.paymentMethod,
      input.paymentStatus,
      input.razorpayOrderId ?? null,
      input.razorpayPaymentId ?? null,
    ]
  );
  const order = await findOrderById(result.insertId);
  if (!order) throw new Error("Failed to load created order");
  return order;
}

export async function findOrderById(orderUID: number): Promise<OrderRecord | null> {
  const [rows] = await mysqlReadPool.query<RowDataPacket[]>(`${SELECT} WHERE o.OrderUID = ?`, [orderUID]);
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function findOrderByIdForUser(orderUID: number, userUID: number): Promise<OrderRecord | null> {
  const [rows] = await mysqlReadPool.query<RowDataPacket[]>(`${SELECT} WHERE o.OrderUID = ? AND o.UserUID = ?`, [
    orderUID,
    userUID,
  ]);
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function findOrdersByUser(userUID: number): Promise<OrderRecord[]> {
  const [rows] = await mysqlReadPool.query<RowDataPacket[]>(`${SELECT} WHERE o.UserUID = ? ORDER BY o.CreatedOn DESC`, [
    userUID,
  ]);
  return rows.map(mapRow);
}

export async function findAllOrders(status?: OrderStatus): Promise<OrderRecord[]> {
  const where = status ? "WHERE o.Status = ?" : "";
  const params = status ? [status] : [];
  const [rows] = await mysqlReadPool.query<RowDataPacket[]>(
    `SELECT o.OrderUID AS orderUID, o.UserUID AS userUID, o.OrgUID AS orgUID, o.Items AS items,
            o.ShippingAddress AS shippingAddress, o.TotalAmount AS totalAmount, o.Status AS status,
            o.PaymentMethod AS paymentMethod, o.PaymentStatus AS paymentStatus,
            o.RazorpayOrderId AS razorpayOrderId, o.RazorpayPaymentId AS razorpayPaymentId,
            o.CreatedOn AS createdOn, o.UpdatedOn AS updatedOn,
            u.Name AS userName, u.Email AS userEmail
     FROM OrderTbl o
     LEFT JOIN UserTbl u ON u.UserUID = o.UserUID
     ${where}
     ORDER BY o.CreatedOn DESC`,
    params
  );
  return rows.map(mapRow);
}

export async function updateOrderStatus(orderUID: number, status: OrderStatus): Promise<OrderRecord | null> {
  await mysqlWritePool.query(`UPDATE OrderTbl SET Status = ? WHERE OrderUID = ?`, [status, orderUID]);
  return findOrderById(orderUID);
}
