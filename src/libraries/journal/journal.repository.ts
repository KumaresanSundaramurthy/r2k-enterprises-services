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
  async insertBankLedgerEntry(row: Row, trx?: Knex.Transaction): Promise<void> {
    await (trx ?? this.db.write)("Transaction.AccountLedgerTbl").insert(row);
  }

  // getSystemLedgerByCode — the organisation's system ledger (SYS-EXPENSE, SYS-AP, …)
  async systemLedgerUID(trx: Knex.Transaction, orgUID: number, code: string): Promise<number | null> {
    const row = await trx("Accounting.ChartOfAccounts").select("LedgerUID").where({ LedgerCode: code, OrgUID: orgUID, IsDeleted: 0 }).first();
    return row ? Number(row.LedgerUID) : null;
  }

  // getJournalByReference — live journals posted for a record
  async journalsByReference(trx: Knex.Transaction, orgUID: number, referenceType: string, referenceID: number): Promise<Row[]> {
    return trx("Accounting.GeneralJournal")
      .select("JournalUID", "JournalNo", "FinancialYear")
      .where({ ReferenceType: referenceType, ReferenceID: referenceID, OrgUID: orgUID, IsDeleted: 0 });
  }

  // getJournalEntries
  async journalEntries(trx: Knex.Transaction, orgUID: number, journalUID: number): Promise<Row[]> {
    return trx("Accounting.JournalEntries")
      .select("EntryUID", "LedgerUID", "TransactionType", "Amount", "Particulars")
      .where({ JournalUID: journalUID, OrgUID: orgUID, IsDeleted: 0 });
  }

  // A manual journal's own reference: ReferenceID = its JournalUID, ReferenceNo = its JournalNo
  async setReference(trx: Knex.Transaction, orgUID: number, journalUID: number, referenceID: number, referenceNo: string): Promise<void> {
    await trx("Accounting.GeneralJournal").where({ JournalUID: journalUID, OrgUID: orgUID }).update({ ReferenceID: referenceID, ReferenceNo: referenceNo });
  }

  // A live journal header, locked for a reversal
  async liveJournal(trx: Knex.Transaction, orgUID: number, journalUID: number): Promise<Row | null> {
    const row = await trx("Accounting.GeneralJournal")
      .select("JournalUID", "JournalNo", "FinancialYear", "ReferenceType", "Narration")
      .where({ JournalUID: journalUID, OrgUID: orgUID, IsDeleted: 0 })
      .forUpdate()
      .first();
    return row ?? null;
  }

  // The journal header and its lines are soft-deleted (reverseJournal)
  async softDeleteJournal(trx: Knex.Transaction, orgUID: number, journalUID: number): Promise<void> {
    await trx("Accounting.GeneralJournal").where({ OrgUID: orgUID, JournalUID: journalUID }).update({ IsDeleted: 1 });
    await trx("Accounting.JournalEntries").where({ OrgUID: orgUID, JournalUID: journalUID, IsDeleted: 0 }).update({ IsDeleted: 1 });
  }

  // Live payments of one record, oldest first (ensurePaymentJournals)
  async activePayments(trx: Knex.Transaction, orgUID: number, transUID: number, sourceType: string): Promise<Row[]> {
    return trx("Transaction.PaymentsTbl")
      .select("PaymentUID", trx.raw("DATE_FORMAT(PaymentDate, '%Y-%m-%d') AS PaymentDate"), "TransYear", "Amount")
      .where({ TransUID: transUID, SourceType: sourceType, OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy("PaymentUID", "asc");
  }
}
