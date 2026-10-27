import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export interface EntityLedgerRow {
  LedgerUID: string;
  LedgerName: string;
  OpeningBalance: string | null;
  OpeningBalanceType: string | null;
  CurrentBalance: string | null;
  CurrentBalanceType: string | null;
}

// Accounting.* queries behind the ledger library (CI3 Accountledger_model).
@Injectable()
export class AccountLedgerRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getLedgerById(id, type) — used to check the parent ledger exists
  async ledgerExists(ledgerUID: number, ledgerType: string): Promise<boolean> {
    const row = await this.read("Accounting.ChartOfAccounts").select("LedgerUID").where({ LedgerUID: ledgerUID, LedgerType: ledgerType }).first();
    return !!row;
  }

  // getEntityLedgerByColumn — the entity's ledger (mapping row joined with the ledger).
  async findEntityLedger(
    orgUID: number,
    entityColumn: string,
    entityUID: number,
    entityType: string,
    trx?: Knex.Transaction
  ): Promise<EntityLedgerRow | null> {
    const row = await (trx ?? this.read)("Accounting.EntityLedgerMap as el")
      .select(
        "el.LedgerUID as LedgerUID",
        "ca.LedgerName as LedgerName",
        "ca.OpeningBalance as OpeningBalance",
        "ca.OpeningBalanceType as OpeningBalanceType",
        "ca.CurrentBalance as CurrentBalance",
        "ca.CurrentBalanceType as CurrentBalanceType"
      )
      .join("Accounting.ChartOfAccounts as ca", "ca.LedgerUID", "el.LedgerUID")
      .where({ [`el.${entityColumn}`]: entityUID, "el.OrgUID": orgUID, "el.EntityType": entityType })
      .first();
    return row ?? null;
  }

  // ledgerHasTransactions — any posted journal line
  async hasTransactions(orgUID: number, ledgerUID: number, trx?: Knex.Transaction): Promise<boolean> {
    const row = await (trx ?? this.read)("Accounting.JournalEntries")
      .select("EntryUID")
      .where({ LedgerUID: ledgerUID, IsDeleted: 0, OrgUID: orgUID })
      .first();
    return !!row;
  }

  async insertLedger(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number> {
    const [ledgerUID] = await trx("Accounting.ChartOfAccounts").insert(row);
    return ledgerUID;
  }

  async updateLedger(trx: Knex.Transaction, orgUID: number, ledgerUID: number, data: Record<string, unknown>): Promise<void> {
    await trx("Accounting.ChartOfAccounts").where({ OrgUID: orgUID, LedgerUID: ledgerUID }).update(data);
  }

  async insertYearOpening(trx: Knex.Transaction, row: Record<string, unknown>): Promise<void> {
    await trx("Accounting.LedgerYearOpening").insert(row);
  }

  async updateYearOpening(trx: Knex.Transaction, orgUID: number, ledgerUID: number, financialYear: number, data: Record<string, unknown>) {
    await trx("Accounting.LedgerYearOpening").where({ OrgUID: orgUID, LedgerUID: ledgerUID, FinancialYear: financialYear }).update(data);
  }

  async insertEntityMap(trx: Knex.Transaction, row: Record<string, unknown>): Promise<void> {
    await trx("Accounting.EntityLedgerMap").insert(row);
  }

  async deactivateEntityMap(trx: Knex.Transaction, orgUID: number, ledgerUID: number, entityType: string): Promise<void> {
    await trx("Accounting.EntityLedgerMap").where({ OrgUID: orgUID, LedgerUID: ledgerUID, EntityType: entityType }).update({ IsDeleted: 1 });
  }

  async insertAudit(trx: Knex.Transaction, row: Record<string, unknown>): Promise<void> {
    await trx("Accounting.LedgerAuditTrail").insert(row);
  }
}
