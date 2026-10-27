import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { WriteContext } from "../../core/request/write-context";

/** Table layout of one party type, e.g. customers or vendors (CI3 passes these as arguments to Globalservice). */
export interface PartyTables {
  schema: string; // e.g. "Customers"
  entityColumn: string; // e.g. "CustomerUID"
  bankTable: string; // e.g. "CustBankDetailsTbl"
  bankPk: string; // e.g. "CustBankDetUID"
  addressTable: string; // e.g. "CustAddressTbl"
  addressPk: string; // e.g. "CustAddressUID"
}

// One bank row as the CI3 form sends it in BankDetailsJSON
export interface BankDetailInput {
  id?: string | number; // "New-…" = insert, numeric = update
  type?: string | null;
  accNumber?: string | null;
  ifsc?: string | null;
  branch?: string | null;
  holder?: string | null;
  upiId?: string | null;
}

// One address as the CI3 form sends it ({Bill|Ship}AddrLine1, ... , {Bill|Ship}AddressUID)
export interface AddressInput {
  addressUID?: number | string | null; // 0 = insert, > 0 = update, absent = leave alone
  line1?: string | null;
  line2?: string | null;
  pincode?: string | null;
  city?: string | null;
  cityText?: string | null;
  state?: string | null;
  stateText?: string | null;
}

// CI3 getPostValue(): missing or empty string → default
const valueOrNull = (value: unknown): string | null => (value === undefined || value === null || value === "" ? null : String(value));

/**
 * Bank details and addresses of a party (CI3 Globalservice saveBankDetails / saveAddressInfo /
 * softDelete*Records). Shared by every party type through PartyTables.
 */
@Injectable()
export class PartyDetailsService {
  // saveBankDetails — "New-…" ids are inserted, numeric ids updated.
  async saveBankDetails(trx: Knex.Transaction, tables: PartyTables, entityUID: number, details: BankDetailInput[], ctx: WriteContext) {
    const inserts: Record<string, unknown>[] = [];
    for (const record of details) {
      const row = {
        [tables.entityColumn]: entityUID,
        Type: record.type ?? null,
        BankAccountNumber: valueOrNull(record.accNumber),
        BankIFSC_Code: valueOrNull(record.ifsc),
        BankBranchName: valueOrNull(record.branch),
        BankAccountHolderName: valueOrNull(record.holder),
        UPI_Id: valueOrNull(record.upiId),
        UpdatedBy: ctx.userUID,
      };
      const id = record.id;
      if (typeof id === "string" && id.startsWith("New-")) {
        inserts.push({ ...row, CreatedBy: ctx.userUID });
      } else if (typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) {
        await trx(`${tables.schema}.${tables.bankTable}`).where({ [tables.bankPk]: Number(id) }).update(row);
      }
    }
    if (inserts.length > 0) await trx(`${tables.schema}.${tables.bankTable}`).insert(inserts);
  }

  // saveAddressInfo — skipped when Line1 is empty; addressUID 0 inserts, > 0 updates.
  async saveAddress(
    trx: Knex.Transaction,
    tables: PartyTables,
    entityUID: number,
    addressType: "Billing" | "Shipping",
    address: AddressInput,
    ctx: WriteContext
  ) {
    if (!address.line1) return;
    const row = {
      [tables.entityColumn]: entityUID,
      OrgUID: ctx.orgUID,
      AddressType: addressType,
      Line1: address.line1,
      Line2: valueOrNull(address.line2),
      Pincode: address.pincode ?? null,
      City: valueOrNull(address.city),
      CityText: valueOrNull(address.cityText),
      State: valueOrNull(address.state),
      StateText: valueOrNull(address.stateText),
      UpdatedBy: ctx.userUID,
    };
    const addressUID = address.addressUID === undefined || address.addressUID === null ? null : Number(address.addressUID);
    if (addressUID === 0) {
      await trx(`${tables.schema}.${tables.addressTable}`).insert({ ...row, CreatedBy: ctx.userUID });
    } else if (addressUID !== null && addressUID > 0) {
      await trx(`${tables.schema}.${tables.addressTable}`).where({ [tables.addressPk]: addressUID }).update(row);
    }
  }

  // softDeleteBankRecords
  async softDeleteBankRecords(trx: Knex.Transaction, tables: PartyTables, recordUIDs: number[], ctx: WriteContext) {
    if (recordUIDs.length === 0) return;
    await trx(`${tables.schema}.${tables.bankTable}`)
      .whereIn(tables.bankPk, recordUIDs)
      .update({ IsDeleted: 1, UpdatedBy: ctx.userUID });
  }

  // softDeleteAddressRecords
  async softDeleteAddresses(trx: Knex.Transaction, tables: PartyTables, addressUIDs: number[], ctx: WriteContext) {
    if (addressUIDs.length === 0) return;
    await trx(`${tables.schema}.${tables.addressTable}`)
      .whereIn(tables.addressPk, addressUIDs)
      .update({ IsDeleted: 1, UpdatedBy: ctx.userUID });
  }
}
