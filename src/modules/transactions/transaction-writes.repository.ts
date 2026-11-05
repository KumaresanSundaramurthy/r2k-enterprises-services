import { Injectable } from "@nestjs/common";
import { Knex } from "knex";

type Row = Record<string, unknown>;

const TRANSACTIONS = "Transaction.TransactionsTbl";
const ITEMS = "Transaction.TransProductsTbl";
const DETAILS = "Transaction.TransDetailTbl";
const CHARGES = "Transaction.TransactionChargesTbl";

// One posted additional charge (AdditionalCharges JSON)
export interface ChargeInput {
  chargeUID?: unknown;
  chargeName?: unknown;
  chargeDisplayName?: unknown;
  inPercent?: unknown;
  withoutTaxAmount?: unknown;
  taxUID?: unknown;
  taxPercent?: unknown;
  taxAmount?: unknown;
  withTaxAmount?: unknown;
  sortOrder?: unknown;
}

/** Transaction writes (CI3 Dbwrite_ext_model / Transactions_model write helpers); all inside the caller's transaction. */
@Injectable()
export class TransactionWritesRepository {
  async insertHeader(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx(TRANSACTIONS).insert(row);
    return Number(id);
  }

  async updateHeader(trx: Knex.Transaction, orgUID: number, transUID: number, data: Row): Promise<void> {
    await trx(TRANSACTIONS).where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  // The superseded draft row of the clone path (CI3 deleteInTransaction)
  async deleteHeader(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<void> {
    await trx(TRANSACTIONS).where({ TransUID: transUID, OrgUID: orgUID }).delete();
  }

  // softDeleteTransaction
  async softDeleteHeader(trx: Knex.Transaction, orgUID: number, transUID: number, userUID: number): Promise<void> {
    await trx(TRANSACTIONS).where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID, UpdatedOn: trx.fn.now() });
  }

  // cancelTransactionChildRecords — a cancelled document's lines, BOM snapshot and files are flagged IsCancelled
  async cancelChildRecords(trx: Knex.Transaction, orgUID: number, transUID: number, userUID: number): Promise<void> {
    for (const table of ["Transaction.TransProductsTbl", "Transaction.TransProductBOMTbl", "Transaction.TransAttachmentsTbl"]) {
      await trx(table).where({ TransUID: transUID, OrgUID: orgUID }).update({ IsCancelled: 1, UpdatedBy: userUID });
    }
  }

  async insertDetail(trx: Knex.Transaction, row: Row): Promise<void> {
    await trx(DETAILS).insert(row);
  }

  // The detail row is keyed by TransUID and the financial year of the document date
  async updateDetail(trx: Knex.Transaction, transUID: number, financialYear: number, data: Row): Promise<void> {
    await trx(DETAILS).where({ TransUID: transUID, FinancialYear: financialYear }).update(data);
  }

  async insertItems(trx: Knex.Transaction, rows: Row[]): Promise<void> {
    if (rows.length > 0) await trx(ITEMS).insert(rows);
  }

  // softDeleteTransactionItems
  async softDeleteItems(trx: Knex.Transaction, orgUID: number, transUID: number, userUID: number): Promise<void> {
    await trx(ITEMS).where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID, UpdatedOn: trx.fn.now() });
  }

  // softDeleteTransactionItemsByProductUIDs — removed lines also give up their sequence slot
  async softDeleteItemsByProducts(trx: Knex.Transaction, orgUID: number, transUID: number, productUIDs: number[], userUID: number): Promise<void> {
    if (productUIDs.length === 0) return;
    await trx(ITEMS)
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 })
      .whereIn("ProductUID", productUIDs)
      .update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID, UpdatedOn: trx.fn.now(), ItemSequence: null });
  }

  // shiftTransProductSequences — kept lines vacate their slots before renumbering (unique year+trans+sequence)
  async clearSequences(trx: Knex.Transaction, orgUID: number, transUID: number, productUIDs: number[]): Promise<void> {
    if (productUIDs.length === 0) return;
    await trx(ITEMS).where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).whereIn("ProductUID", productUIDs).update({ ItemSequence: null });
  }

  // updateTransProductItem
  async updateItem(trx: Knex.Transaction, orgUID: number, transUID: number, productUID: number, data: Row): Promise<void> {
    await trx(ITEMS).where({ TransUID: transUID, OrgUID: orgUID, ProductUID: productUID, IsDeleted: 0 }).update(data);
  }

  // The live lines of a document (the update diff and the duplicate)
  async liveProductUIDs(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<number[]> {
    const rows: Row[] = await trx(ITEMS).select("ProductUID").where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 });
    return rows.map((row) => Number(row.ProductUID));
  }

  async setStatus(trx: Knex.Transaction, orgUID: number, transUID: number, status: string, userUID: number): Promise<void> {
    await trx(TRANSACTIONS).where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).update({ DocStatus: status, UpdatedBy: userUID, UpdatedOn: trx.fn.now() });
  }

  /**
   * saveTransactionCharges — charges with an amount are updated in place (by ChargeUID) or inserted; charges the
   * user removed (or zeroed) are soft-deleted.
   */
  async saveCharges(trx: Knex.Transaction, orgUID: number, transUID: number, userUID: number, charges: ChargeInput[]): Promise<void> {
    const existing: Row[] = await trx(CHARGES).select("TransChargeUID", "ChargeUID").where({ TransactionUID: transUID, OrgUID: orgUID, IsActive: 1, IsDeleted: 0 });
    const existingByCharge = new Map(existing.map((row) => [Number(row.ChargeUID), Number(row.TransChargeUID)]));
    const withAmount = charges.filter((charge) => (Number(charge.withoutTaxAmount) || 0) > 0 || (Number(charge.withTaxAmount) || 0) > 0);
    const kept = new Set(withAmount.map((charge) => parseInt(String(charge.chargeUID ?? 0), 10) || 0).filter((uid) => uid > 0));

    const removed = [...existingByCharge.entries()].filter(([chargeUID]) => !kept.has(chargeUID)).map(([, rowUID]) => rowUID);
    if (removed.length > 0) await trx(CHARGES).whereIn("TransChargeUID", removed).where({ IsDeleted: 0 }).update({ IsActive: 0, IsDeleted: 1, UpdatedBy: userUID });

    for (const charge of withAmount) {
      const chargeUID = parseInt(String(charge.chargeUID ?? 0), 10) || 0;
      const data = {
        ChargeName: String(charge.chargeName ?? ""),
        ChargeDisplayName: String(charge.chargeDisplayName ?? ""),
        InPercent: Number(charge.inPercent) || 0,
        WithoutTaxAmount: Number(charge.withoutTaxAmount) || 0,
        TaxUID: parseInt(String(charge.taxUID ?? 0), 10) || null,
        TaxPercent: Number(charge.taxPercent) || 0,
        TaxAmount: Number(charge.taxAmount) || 0,
        WithTaxAmount: Number(charge.withTaxAmount) || 0,
        SortOrder: parseInt(String(charge.sortOrder ?? 0), 10) || 0,
        UpdatedBy: userUID,
      };
      const rowUID = existingByCharge.get(chargeUID);
      if (rowUID) await trx(CHARGES).where({ TransChargeUID: rowUID, IsDeleted: 0 }).update(data);
      else await trx(CHARGES).insert({ ...data, OrgUID: orgUID, TransactionUID: transUID, ChargeUID: chargeUID, IsActive: 1, IsDeleted: 0, CreatedBy: userUID });
    }
  }

  // The clone path moves the draft's charges and files to the new row (CI3 left them on the deleted draft)
  async moveChildren(trx: Knex.Transaction, orgUID: number, fromTransUID: number, toTransUID: number): Promise<void> {
    await trx(CHARGES).where({ TransactionUID: fromTransUID, OrgUID: orgUID }).update({ TransactionUID: toTransUID });
    await trx("Transaction.TransAttachmentsTbl").where({ TransUID: fromTransUID, OrgUID: orgUID }).update({ TransUID: toTransUID });
  }

  // insertConversionRecord — once per source + target
  async recordConversion(trx: Knex.Transaction, row: { OrgUID: number; SourceTransUID: number; SourceModuleUID: number; TargetTransUID: number; TargetModuleUID: number; ConversionType: string; CreatedBy: number }): Promise<void> {
    const exists = await trx("Transaction.TransConversionTbl").select("ConversionUID").where({ SourceTransUID: row.SourceTransUID, TargetTransUID: row.TargetTransUID }).first();
    if (!exists) await trx("Transaction.TransConversionTbl").insert({ ...row, UpdatedBy: row.CreatedBy });
  }

  // getOrCreateTransToken — the document's public token, created for legacy rows without one
  async token(trx: Knex.Transaction | Knex, orgUID: number, transUID: number, newToken: string): Promise<string> {
    const row = await trx(TRANSACTIONS).select("TransToken").where({ TransUID: transUID, OrgUID: orgUID }).first();
    if (row?.TransToken) return String(row.TransToken);
    await trx(TRANSACTIONS).where({ TransUID: transUID, OrgUID: orgUID }).update({ TransToken: newToken });
    return newToken;
  }
}
