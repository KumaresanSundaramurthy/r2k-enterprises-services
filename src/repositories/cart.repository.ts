import { RowDataPacket, ResultSetHeader } from "mysql2";
import { mysqlReadPool, mysqlWritePool } from "../config/mysql";

export interface CartItem {
  productId: number;
  variantId: number | null;
  name: string;
  brand: string | null;
  size: string | null;
  imageUrl: string | null;
  quantity: number;
  price: number;
}

export interface CartRecord {
  cartUID: number;
  userUID: number;
  items: CartItem[];
  createdOn: Date;
  updatedOn: Date;
}

const SELECT = `
  SELECT CartUID AS cartUID, UserUID AS userUID, Items AS items, CreatedOn AS createdOn, UpdatedOn AS updatedOn
  FROM CartTbl
`;

function mapRow(row: RowDataPacket): CartRecord {
  return {
    cartUID: row.cartUID,
    userUID: row.userUID,
    items: row.items,
    createdOn: row.createdOn,
    updatedOn: row.updatedOn,
  };
}

export async function getCartByUser(userUID: number): Promise<CartRecord | null> {
  const [rows] = await mysqlReadPool.query<RowDataPacket[]>(`${SELECT} WHERE UserUID = ?`, [userUID]);
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function createCart(userUID: number): Promise<CartRecord> {
  await mysqlWritePool.query<ResultSetHeader>(`INSERT INTO CartTbl (UserUID, Items) VALUES (?, ?)`, [
    userUID,
    JSON.stringify([]),
  ]);
  const cart = await getCartByUser(userUID);
  if (!cart) throw new Error("Failed to load created cart");
  return cart;
}

export async function saveCartItems(userUID: number, items: CartItem[]): Promise<void> {
  await mysqlWritePool.query(`UPDATE CartTbl SET Items = ? WHERE UserUID = ?`, [JSON.stringify(items), userUID]);
}
