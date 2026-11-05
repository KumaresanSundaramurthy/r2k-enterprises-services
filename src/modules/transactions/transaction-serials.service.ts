import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";
import { ItemInput } from "./transaction-form";

const SERIALS = "Transaction.ProductSerialsTbl";

// The documents whose serial numbers are tracked
export type SerialDocument = "Purchase" | "PurchaseReturn" | "Invoice" | "SalesReturn";

const productOf = (item: ItemInput) => {
  const productUID = parseInt(String(item.productUID ?? ""), 10);
  return Number.isNaN(productUID) ? parseInt(String(item.id ?? 0), 10) || 0 : productUID;
};

// The line's serials as posted (trimmed, blanks dropped)
const postedSerials = (item: ItemInput): string[] =>
  Array.isArray(item.serials) ? (item.serials as unknown[]).map((serial) => String(serial ?? "").trim()).filter((serial) => serial !== "") : [];

// The line's serials without repeats (edit diff)
const serialsOf = (item: ItemInput): string[] => [...new Set(postedSerials(item))];

/**
 * Serial numbers of serial-tracked lines (CI3 MY_Controller::_saveTransSerials / _updateTransSerials /
 * _getTransSerialsGrouped). A purchase adds each serial as Available; an invoice sells Available serials; a sales
 * return brings Sold serials back to Available; a purchase return marks Available serials Returned. Writes run
 * inside the document's transaction.
 */
@Injectable()
export class TransactionSerialsService {
  constructor(private readonly db: DatabaseService) {}

  // _saveTransSerials — a newly saved (non-draft) document; partyUID is the customer of an invoice
  async save(trx: Knex.Transaction, type: SerialDocument, ctx: WriteContext, transUID: number, items: ItemInput[], partyUID = 0): Promise<void> {
    const { orgUID, userUID } = ctx;
    for (const item of items) {
      const productUID = productOf(item);
      if (productUID <= 0) continue;
      const serials = postedSerials(item);
      if (serials.length === 0) continue;
      if (type === "Purchase") {
        await trx(SERIALS).insert(serials.map((serial) => ({ OrgUID: orgUID, ProductUID: productUID, SerialNumber: serial, Status: "Available", PurchaseTransUID: transUID, IsDeleted: 0, CreatedBy: userUID, UpdatedBy: userUID })));
        continue;
      }
      for (const serial of serials) await this.move(trx, type, ctx, transUID, productUID, serial, partyUID);
    }
  }

  /**
   * _updateTransSerials — an edited document: serials no longer posted go back (a purchase's are deleted, a sale's
   * become Available, a sales return's Sold again, a purchase return's Available) and newly posted ones are added
   * as on save.
   */
  async update(trx: Knex.Transaction, type: SerialDocument, ctx: WriteContext, transUID: number, items: ItemInput[], partyUID = 0): Promise<void> {
    const { orgUID, userUID } = ctx;
    for (const item of items) {
      const productUID = productOf(item);
      if (productUID <= 0) continue;
      const posted = serialsOf(item);
      const stored = (await trx(SERIALS).select("SerialNumber").where({ OrgUID: orgUID, ProductUID: productUID, IsDeleted: 0, ...TransactionSerialsService.scope(type, transUID) })).map(
        (row: { SerialNumber: string }) => row.SerialNumber
      );
      const removed = stored.filter((serial) => !posted.includes(serial));
      const added = posted.filter((serial) => !stored.includes(serial));

      for (const serial of removed) {
        const where = { OrgUID: orgUID, ProductUID: productUID, SerialNumber: serial };
        if (type === "Purchase") await trx(SERIALS).where({ ...where, PurchaseTransUID: transUID }).update({ IsDeleted: 1, UpdatedBy: userUID });
        else if (type === "Invoice") await trx(SERIALS).where({ ...where, SaleTransUID: transUID, IsDeleted: 0 }).update({ Status: "Available", SaleTransUID: null, CustomerUID: null, UpdatedBy: userUID });
        else if (type === "SalesReturn") await trx(SERIALS).where({ ...where, ReturnTransUID: transUID, IsDeleted: 0 }).update({ Status: "Sold", ReturnTransUID: null, UpdatedBy: userUID });
        else await trx(SERIALS).where({ ...where, ReturnTransUID: transUID, IsDeleted: 0 }).update({ Status: "Available", ReturnTransUID: null, UpdatedBy: userUID });
      }
      if (added.length > 0) await this.save(trx, type, ctx, transUID, [{ productUID, serials: added }], partyUID);
    }
  }

  // _getTransSerialsGrouped — { productUID: [serial, …] } for the edit form
  async grouped(orgUID: number, transUID: number, type: SerialDocument): Promise<Record<number, string[]>> {
    const query = this.db.read(SERIALS).select("ProductUID", "SerialNumber").where({ OrgUID: orgUID, IsDeleted: 0, ...TransactionSerialsService.scope(type, transUID) }).orderBy([{ column: "ProductUID" }, { column: "SerialNumber" }]);
    const grouped: Record<number, string[]> = {};
    for (const row of (await query) as { ProductUID: string; SerialNumber: string }[]) (grouped[Number(row.ProductUID)] ??= []).push(row.SerialNumber);
    return grouped;
  }

  // One serial changes hands: sold, returned by the customer or returned to the vendor
  private async move(trx: Knex.Transaction, type: SerialDocument, ctx: WriteContext, transUID: number, productUID: number, serial: string, partyUID: number): Promise<void> {
    const where = { OrgUID: ctx.orgUID, ProductUID: productUID, SerialNumber: serial, IsDeleted: 0 };
    if (type === "Invoice") {
      await trx(SERIALS).where({ ...where, Status: "Available" }).update({ Status: "Sold", SaleTransUID: transUID, CustomerUID: partyUID > 0 ? partyUID : null, UpdatedBy: ctx.userUID });
    } else if (type === "SalesReturn") {
      await trx(SERIALS).where({ ...where, Status: "Sold" }).update({ Status: "Available", SaleTransUID: null, CustomerUID: null, ReturnTransUID: transUID, UpdatedBy: ctx.userUID });
    } else {
      await trx(SERIALS).where({ ...where, Status: "Available" }).update({ Status: "Returned", ReturnTransUID: transUID, UpdatedBy: ctx.userUID });
    }
  }

  // Which serials belong to the document
  private static scope(type: SerialDocument, transUID: number): Record<string, unknown> {
    if (type === "Purchase") return { PurchaseTransUID: transUID };
    if (type === "Invoice") return { SaleTransUID: transUID };
    if (type === "SalesReturn") return { ReturnTransUID: transUID, Status: "Available" };
    return { ReturnTransUID: transUID, Status: "Returned" };
  }
}
