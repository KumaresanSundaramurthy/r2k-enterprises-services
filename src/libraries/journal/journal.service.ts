import { Injectable, Logger } from "@nestjs/common";
import { Knex } from "knex";
import { phpRound } from "../../common/utils/php-compat";
import { CiValidationError } from "../../core/response/ci-response";
import { AccountLedgerRepository } from "../account-ledger/account-ledger.repository";
import { JournalRepository } from "./journal.repository";

// CI3 Accountledger::_dec — journal amounts are kept to 4 decimals
const DECIMALS = 4;

export type JournalSide = "Debit" | "Credit";

export interface JournalHeader {
  orgUID: number;
  date: string;
  financialYear: number;
  referenceType: string;
  referenceID: number;
  referenceNo: string | null;
  narration: string;
  userUID: number;
}

export interface BankLedgerEntry {
  orgUID: number;
  bankAccountUID: number | null;
  entryType: "CR" | "DR";
  amount: number;
  sourceType: string;
  sourceUID: number | null;
  moduleUID: number | null;
  referenceNo: string | null;
  narration: string;
  entryDate: string;
  userUID: number;
}

/**
 * Double-entry journal posting (CI3 Accountledger: _createJournalHeader, _addJournalLine, bank ledgers) and the
 * bank/cash book (MY_Controller::_writeBankLedgerEntry). Every posting keeps LedgerBalances' running balance and
 * the ledger's CurrentBalance in step, as CI3 does.
 */
@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(
    private readonly repo: JournalRepository,
    private readonly ledgers: AccountLedgerRepository
  ) {}

  // createBankLedger / _getOrCreateBankLedgerUID — the bank's ChartOfAccounts ledger, created when missing
  async bankLedgerUID(trx: Knex.Transaction, orgUID: number, bankUID: number, userUID: number): Promise<number | null> {
    const existing = await this.ledgers.findEntityLedger(orgUID, "BankUID", bankUID, "Bank", trx);
    if (existing) return Number(existing.LedgerUID);

    const bank = await this.repo.bankAccount(orgUID, bankUID, trx);
    if (!bank) return null;
    const isCash = Number(bank.IsCash) === 1;
    const groupUID = await this.repo.accountGroupUID(orgUID, isCash ? "CASH_IN_HAND" : "BANK_ACCOUNTS", trx);
    if (!groupUID) return null;

    const ledgerUID = Number(
      await this.ledgers.insertLedger(trx, {
        OrgUID: orgUID,
        GroupUID: groupUID,
        LedgerCode: `${isCash ? "CASH" : "BNK"}-${String(bankUID).padStart(5, "0")}`,
        LedgerName: String(bank.AccountName ?? "") + (bank.BankName ? ` (${bank.BankName})` : ""),
        Nature: "Asset",
        NatureSign: "Dr",
        IsContra: 0,
        IsPostable: 1,
        IsSystem: 0,
        IsBankAccount: isCash ? 0 : 1,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      })
    );
    await this.ledgers.insertEntityMap(trx, { OrgUID: orgUID, LedgerUID: ledgerUID, BankUID: bankUID, EntityType: "Bank", CreatedBy: userUID, UpdatedBy: userUID });
    return ledgerUID;
  }

  // _createJournalHeader — refused for a locked period; JournalNo is JRN-{FY}-{id, 7 digits}
  async createHeader(trx: Knex.Transaction, header: JournalHeader): Promise<number> {
    const lockedUpTo = await this.repo.lockedUpTo(header.orgUID, trx);
    if (lockedUpTo && header.date <= lockedUpTo) {
      throw new CiValidationError(`Cannot post to a locked period. Books are locked up to ${JournalService.displayDate(lockedUpTo)}.`);
    }
    const journalUID = await this.repo.insertJournal(trx, {
      OrgUID: header.orgUID,
      JournalNo: `TMP-${header.orgUID}-${Date.now() / 1000}-${header.referenceID}`,
      JournalDate: header.date,
      FinancialYear: header.financialYear,
      ReferenceType: header.referenceType,
      ReferenceID: header.referenceID,
      ReferenceNo: header.referenceNo,
      Narration: header.narration,
      IsDeleted: 0,
      CreatedBy: header.userUID,
    });
    await this.repo.setJournalNo(trx, header.orgUID, journalUID, `JRN-${header.financialYear}-${String(journalUID).padStart(7, "0")}`);
    return journalUID;
  }

  // _addJournalLine — the entry, its LedgerBalances row and the ledger's CurrentBalance
  async addLine(trx: Knex.Transaction, header: JournalHeader, journalUID: number, ledgerUID: number, side: JournalSide, amount: number, particulars: string): Promise<void> {
    const value = phpRound(amount, DECIMALS);
    if (value <= 0 || !ledgerUID) return;
    const { orgUID, financialYear, userUID } = header;

    const entryUID = await this.repo.insertEntry(trx, {
      OrgUID: orgUID,
      JournalUID: journalUID,
      LedgerUID: ledgerUID,
      TransactionType: side,
      Amount: value,
      Particulars: particulars,
      IsDeleted: 0,
      CreatedBy: userUID,
      UpdatedBy: userUID,
    });

    const last = await this.repo.lastBalance(trx, orgUID, ledgerUID, financialYear);
    const previous = last ? Number(last.RunningBalance) : 0;
    const previousSide = (last?.BalanceType ?? "Debit") as JournalSide;
    let balance: number;
    let balanceSide: JournalSide;
    if (side === previousSide) {
      balance = previous + value;
      balanceSide = previousSide;
    } else if (value >= previous) {
      balance = phpRound(value - previous, DECIMALS);
      balanceSide = side;
    } else {
      balance = phpRound(previous - value, DECIMALS);
      balanceSide = previousSide;
    }

    await this.repo.insertBalance(trx, {
      OrgUID: orgUID,
      LedgerUID: ledgerUID,
      EntryUID: entryUID,
      FinancialYear: financialYear,
      TransactionDate: header.date,
      JournalUID: journalUID,
      DebitAmount: side === "Debit" ? value : 0,
      CreditAmount: side === "Credit" ? value : 0,
      RunningBalance: balance,
      BalanceType: balanceSide,
    });
    await this.repo.setCurrentBalance(trx, orgUID, ledgerUID, { CurrentBalance: balance, CurrentBalanceType: balanceSide, UpdatedBy: userUID });
  }

  // postFundTransferJournal — Dr the receiving bank, Cr the paying bank
  async postFundTransfer(
    trx: Knex.Transaction,
    orgUID: number,
    transferUID: number,
    date: string,
    amount: number,
    fromBankUID: number,
    toBankUID: number,
    userUID: number
  ): Promise<void> {
    const value = phpRound(amount, DECIMALS);
    if (value <= 0) return;
    const fromLedger = await this.bankLedgerUID(trx, orgUID, fromBankUID, userUID);
    const toLedger = await this.bankLedgerUID(trx, orgUID, toBankUID, userUID);
    if (!fromLedger || !toLedger) return;

    // CI3 uses the calendar year of the transfer date as the journal's financial year
    const header: JournalHeader = {
      orgUID,
      date,
      financialYear: Number(date.slice(0, 4)),
      referenceType: "FundTransfer",
      referenceID: transferUID,
      referenceNo: `FT-${transferUID}`,
      narration: `Fund transfer between bank accounts — Ref #${transferUID}`,
      userUID,
    };
    const journalUID = await this.createHeader(trx, header);
    await this.addLine(trx, header, journalUID, toLedger, "Debit", value, `Transfer in — bank account #${toBankUID}`);
    await this.addLine(trx, header, journalUID, fromLedger, "Credit", value, `Transfer out — bank account #${fromBankUID}`);
  }

  // _writeBankLedgerEntry — non-fatal, as in CI3: a failure is logged and the caller carries on
  async writeBankLedgerEntry(entry: BankLedgerEntry): Promise<void> {
    if (!entry.bankAccountUID || entry.amount <= 0) return;
    try {
      await this.repo.insertBankLedgerEntry({
        OrgUID: entry.orgUID,
        BankAccountUID: entry.bankAccountUID,
        EntryDate: entry.entryDate,
        EntryType: entry.entryType,
        Amount: phpRound(entry.amount, DECIMALS),
        SourceType: entry.sourceType,
        SourceUID: entry.sourceUID,
        ModuleUID: entry.moduleUID,
        ReferenceNo: entry.referenceNo || null,
        Narration: entry.narration,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: entry.userUID,
        UpdatedBy: entry.userUID,
      });
    } catch (err) {
      this.logger.error(`Bank ledger entry for ${entry.sourceType} ${entry.sourceUID} failed: ${(err as Error).message}`);
    }
  }

  // PHP date('d M Y')
  private static displayDate(ymd: string): string {
    const [y, m, d] = ymd.split("-").map(Number);
    const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
    return `${String(d).padStart(2, "0")} ${month} ${y}`;
  }
}
