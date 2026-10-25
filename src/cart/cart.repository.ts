import { Injectable } from "@nestjs/common";
import { knexRead, knexWrite } from "../config/knex";

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

interface CartTblRow {
  CartUID: number;
  UserUID: number;
  Items: CartItem[];
  CreatedOn: Date;
  UpdatedOn: Date;
}

function mapRow(row: CartTblRow): CartRecord {
  return {
    cartUID: row.CartUID,
    userUID: row.UserUID,
    items: row.Items,
    createdOn: row.CreatedOn,
    updatedOn: row.UpdatedOn,
  };
}

@Injectable()
export class CartRepository {
  async getCartByUser(userUID: number): Promise<CartRecord | null> {
    const row = await knexRead<CartTblRow>("CartTbl").where({ UserUID: userUID }).first();
    return row ? mapRow(row) : null;
  }

  async createCart(userUID: number): Promise<CartRecord> {
    await knexWrite<CartTblRow>("CartTbl").insert({ UserUID: userUID, Items: JSON.stringify([]) as unknown as CartItem[] });
    const cart = await this.getCartByUser(userUID);
    if (!cart) throw new Error("Failed to load created cart");
    return cart;
  }

  async saveCartItems(userUID: number, items: CartItem[]): Promise<void> {
    await knexWrite<CartTblRow>("CartTbl")
      .where({ UserUID: userUID })
      .update({ Items: JSON.stringify(items) as unknown as CartItem[] });
  }
}
