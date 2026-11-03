import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

// Accounting.* and bank-ledger writes behind the journal library (CI3 Accountledger journal helpers).
@Injectable()
export class JournalRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getPeriodLock — books locked up to this date
  async lockedUpTo(orgUID: number, trx: Knex.Transaction): Promise<string | null> {
    const row = await trx("Accounting.PeriodLock").select(trx.raw("DATE_FORMAT(LockedUpTo, '%Y-%m-%d') AS LockedUpTo")).where({ OrgUID: orgUID }).first();
    return row?.LockedUpTo ?? null;
  }

  async bankAccount(orgUID: number, bankUID: number, trx: Knex.Transaction): Promise<Row | null> {
    const row = await trx("Organisation.OrgBankAccountsTbl")
      .select("BankAccountUID", "AccountName", "BankName", "IsCash")
      .where({ BankAccountUID: bankUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  async accountGroupUID(orgUID: number, groupCode: string, trx: Knex.Transaction): Promise<number | null> {
    const row = await trx("Accounting.AccountGroupTbl").select("GroupUID").where({ OrgUID: orgUID, GroupCode: groupCode, IsDeleted: 0 }).first();
    return row ? Number(row.GroupUID) : null;
  }

  async insertJournal(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx("Accounting.GeneralJournal").insert(row);
    return Number(id);
  }

  async setJournalNo(trx: Knex.Transaction, orgUID: number, journalUID: number, journalNo: string): Promise<void> {
    await trx("Accounting.GeneralJournal").where({ JournalUID: journalUID, OrgUID: orgUID }).update({ JournalNo: journalNo });
  }

  async insertEntry(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx("Accounting.JournalEntries").insert(row);
    return Number(id);
  }

  // getLastLedgerBalance — the ledger's running balance in the financial year
  async lastBalance(trx: Knex.Transaction, orgUID: number, ledgerUID: number, financialYear: number): Promise<{ RunningBalance: string; BalanceType: string } | null> {
    const row = await trx("Accounting.LedgerBalances")
      .select("RunningBalance", "BalanceType")
      .where({ LedgerUID: ledgerUID, FinancialYear: financialYear, OrgUID: orgUID })
      .orderBy("BalanceUID", "desc")
      .first();
    return row ?? null;
  }

  async insertBalance(trx: Knex.Transaction, row: Row): Promise<void> {
    await trx("Accounting.LedgerBalances").insert(row);
  }

  async setCurrentBalance(trx: Knex.Transaction, orgUID: number, ledgerUID: number, data: Row): Promise<void> {
    await trx("Accounting.ChartOfAccounts").where({ OrgUID: orgUID, LedgerUID: ledgerUID }).update(data);
  }

  // _writeBankLedgerEntry — one CR/DR line in the bank/cash book
  async insertBankLedgerEntry(row: Row): Promise<void> {
    await this.db.write("Transaction.AccountLedgerTbl").insert(row);
  }
}
