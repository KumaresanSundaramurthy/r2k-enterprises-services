import { Injectable, Logger } from "@nestjs/common";
import { Knex } from "knex";
import { phpRound, todayDate } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { CiValidationError } from "../../core/response/ci-response";
import { AccountLedgerRepository } from "../account-ledger/account-ledger.repository";
import { JournalRepository } from "./journal.repository";

// CI3 Accountledger::_dec — journal amounts are kept to 4 decimals
const DECIMALS = 4;

// LedgerCode of the system ledgers (CI3 Accountledger::_getSystemLedgerUID)
const SYSTEM_LEDGERS = {
  expense: "SYS-EXPENSE",
  indirectIncome: "SYS-IND-INC",
  accountsPayable: "SYS-AP",
  accountsReceivable: "SYS-AR",
  cgstInput: "SYS-CGST-IN",
  sgstInput: "SYS-SGST-IN",
  igstInput: "SYS-IGST-IN",
  stockInHand: "SYS-STOCK",
  purchaseCost: "SYS-PURCH",
  stockAdjustmentLoss: "SYS-STOCK-ADJ",
} as const;

export type JournalSide = "Debit" | "Credit";

// A saved record whose journal is posted (expense, indirect income)
export interface RecordJournal {
  orgUID: number;
  recordUID: number;
  number: string;
  date: string;
  netAmount: number;
  userUID: number;
}

export interface ExpenseJournal extends RecordJournal {
  vendorUID: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
}

export interface PaymentJournal {
  orgUID: number;
  direction: "made" | "received";
  paymentUID: number;
  date: string;
  financialYear: number;
  amount: number;
  partyUID: number;
  entityType: "Vendor" | "Customer";
  userUID: number;
}

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
    private readonly db: DatabaseService,
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

  /**
   * Journal postings that follow a saved record. CI3 posts them after its own commit and ignores a failure, so
   * here they run in a transaction of their own: a failure is logged and leaves no half-written journal behind.
   */
  async postAfterSave(label: string, work: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
    try {
      await this.db.write.transaction(work);
    } catch (err) {
      this.logger.error(`${label} journal failed: ${(err as Error).message}`);
    }
  }

  /**
   * postExpenseJournal — with a vendor ledger: Dr Expense (taxable part), Dr input CGST / SGST / IGST, Cr the vendor
   * (net payable). Otherwise: Dr Expense, Cr Accounts Payable, both for the net amount.
   */
  async postExpense(trx: Knex.Transaction, expense: ExpenseJournal): Promise<void> {
    const net = phpRound(expense.netAmount, DECIMALS);
    if (net <= 0) return;
    const { orgUID } = expense;
    const ref = expense.number || `#${expense.recordUID}`;
    const header = JournalService.recordHeader(expense, "Expense", `Expense ${ref}`);
    const journalUID = await this.createHeader(trx, header);
    const expenseLedger = await this.repo.systemLedgerUID(trx, orgUID, SYSTEM_LEDGERS.expense);

    const vendorLedger = expense.vendorUID > 0 ? await this.ledgers.findEntityLedger(orgUID, "VendorUID", expense.vendorUID, "Vendor", trx) : null;
    if (vendorLedger) {
      const taxable = phpRound(expense.taxableAmount, DECIMALS);
      if (expenseLedger) await this.addLine(trx, header, journalUID, expenseLedger, "Debit", taxable > 0 ? taxable : net, `Expense recorded — ${ref}`);
      for (const [code, amount, label] of [
        [SYSTEM_LEDGERS.cgstInput, expense.cgst, "CGST"],
        [SYSTEM_LEDGERS.sgstInput, expense.sgst, "SGST"],
        [SYSTEM_LEDGERS.igstInput, expense.igst, "IGST"],
      ] as const) {
        if (phpRound(amount, DECIMALS) <= 0) continue;
        const taxLedger = await this.repo.systemLedgerUID(trx, orgUID, code);
        if (taxLedger) await this.addLine(trx, header, journalUID, taxLedger, "Debit", amount, `Input ${label} on expense — ${ref}`);
      }
      await this.addLine(trx, header, journalUID, Number(vendorLedger.LedgerUID), "Credit", net, `Payable to vendor — expense ${ref}`);
      return;
    }

    if (expenseLedger) await this.addLine(trx, header, journalUID, expenseLedger, "Debit", net, `Expense recorded — ${ref}`);
    const payable = await this.repo.systemLedgerUID(trx, orgUID, SYSTEM_LEDGERS.accountsPayable);
    if (payable) await this.addLine(trx, header, journalUID, payable, "Credit", net, `Payable for expense — ${ref}`);
  }

  // postIndirectIncomeJournal — Dr Accounts Receivable, Cr Indirect Income
  async postIndirectIncome(trx: Knex.Transaction, income: RecordJournal): Promise<void> {
    const net = phpRound(income.netAmount, DECIMALS);
    if (net <= 0) return;
    const ref = income.number || `#${income.recordUID}`;
    const header = JournalService.recordHeader(income, "IndirectIncome", `Indirect Income ${ref}`);
    const journalUID = await this.createHeader(trx, header);
    const receivable = await this.repo.systemLedgerUID(trx, income.orgUID, SYSTEM_LEDGERS.accountsReceivable);
    if (receivable) await this.addLine(trx, header, journalUID, receivable, "Debit", net, `Income receivable — ${ref}`);
    const incomeLedger = await this.repo.systemLedgerUID(trx, income.orgUID, SYSTEM_LEDGERS.indirectIncome);
    if (incomeLedger) await this.addLine(trx, header, journalUID, incomeLedger, "Credit", net, `Indirect income recorded — ${ref}`);
  }

  /**
   * postStockAdjustmentJournal — stock in: Dr Stock-in-Hand, Cr Purchase Cost; stock out: Dr Stock Adjustment
   * Loss, Cr Stock-in-Hand. Reference ADJ-{id}; the financial year is the calendar year of the date, as in CI3.
   */
  async postStockAdjustment(trx: Knex.Transaction, orgUID: number, adjUID: number, date: string, adjType: "IN" | "OUT", stockValue: number, userUID: number): Promise<void> {
    const value = phpRound(stockValue, DECIMALS);
    if (value <= 0) return;
    const header: JournalHeader = {
      orgUID,
      date,
      financialYear: Number(date.slice(0, 4)),
      referenceType: "StockAdjustment",
      referenceID: adjUID,
      referenceNo: `ADJ-${adjUID}`,
      narration: `Manual stock ${adjType.toLowerCase()} adjustment — Adj #${adjUID}`,
      userUID,
    };
    const journalUID = await this.createHeader(trx, header);
    const stockLedger = await this.repo.systemLedgerUID(trx, orgUID, SYSTEM_LEDGERS.stockInHand);
    if (adjType === "IN") {
      if (stockLedger) await this.addLine(trx, header, journalUID, stockLedger, "Debit", value, `Stock received — Adj #${adjUID}`);
      const purchaseLedger = await this.repo.systemLedgerUID(trx, orgUID, SYSTEM_LEDGERS.purchaseCost);
      if (purchaseLedger) await this.addLine(trx, header, journalUID, purchaseLedger, "Credit", value, `Stock addition cost — Adj #${adjUID}`);
    } else {
      const lossLedger = await this.repo.systemLedgerUID(trx, orgUID, SYSTEM_LEDGERS.stockAdjustmentLoss);
      if (lossLedger) await this.addLine(trx, header, journalUID, lossLedger, "Debit", value, `Stock removed/written off — Adj #${adjUID}`);
      if (stockLedger) await this.addLine(trx, header, journalUID, stockLedger, "Credit", value, `Stock reduction — Adj #${adjUID}`);
    }
  }

  // postPaymentJournal — a payment made to (Dr) or received from (Cr) the party's ledger; nothing without one
  async postPayment(trx: Knex.Transaction, payment: PaymentJournal): Promise<void> {
    const amount = phpRound(payment.amount, DECIMALS);
    if (amount <= 0) return;
    const column = payment.entityType === "Vendor" ? "VendorUID" : "CustomerUID";
    const partyLedger = await this.ledgers.findEntityLedger(payment.orgUID, column, payment.partyUID, payment.entityType, trx);
    if (!partyLedger) return;

    const made = payment.direction === "made";
    const header: JournalHeader = {
      orgUID: payment.orgUID,
      date: payment.date,
      financialYear: payment.financialYear,
      referenceType: made ? "Payment-Out" : "Payment-In",
      referenceID: payment.paymentUID,
      referenceNo: null,
      narration: `${made ? "Payment made" : "Payment received"} — ${payment.entityType} #${payment.partyUID}`,
      userUID: payment.userUID,
    };
    const journalUID = await this.createHeader(trx, header);
    await this.addLine(
      trx,
      header,
      journalUID,
      Number(partyLedger.LedgerUID),
      made ? "Debit" : "Credit",
      amount,
      `${made ? "Payment made" : "Payment received"} against transaction #${payment.paymentUID}`
    );
  }

  // ensurePaymentJournals — journals the record's payments that have none yet, so the vendor balance stays right
  async ensurePaymentJournals(trx: Knex.Transaction, orgUID: number, expenseUID: number, vendorUID: number, userUID: number): Promise<void> {
    for (const payment of await this.repo.activePayments(trx, orgUID, expenseUID, "Expense")) {
      const paymentUID = Number(payment.PaymentUID);
      if ((await this.repo.journalsByReference(trx, orgUID, "Payment-Out", paymentUID)).length > 0) continue;
      await this.postPayment(trx, {
        orgUID,
        direction: "made",
        paymentUID,
        date: String(payment.PaymentDate),
        financialYear: Number(payment.TransYear),
        amount: Number(payment.Amount),
        partyUID: vendorUID,
        entityType: "Vendor",
        userUID,
      });
    }
  }

  // reverseJournal — each live journal of the record is soft-deleted and a dated-today journal with Dr/Cr swapped is posted
  async reverse(trx: Knex.Transaction, orgUID: number, referenceType: string, referenceID: number, userUID: number): Promise<void> {
    const today = todayDate();
    for (const journal of await this.repo.journalsByReference(trx, orgUID, referenceType, referenceID)) {
      const journalUID = Number(journal.JournalUID);
      const entries = await this.repo.journalEntries(trx, orgUID, journalUID);
      await this.repo.softDeleteJournal(trx, orgUID, journalUID);
      if (entries.length === 0) continue;

      const header: JournalHeader = {
        orgUID,
        date: today,
        financialYear: Number(journal.FinancialYear),
        referenceType: `Reversal-${referenceType}`,
        referenceID,
        referenceNo: `REV-${journal.JournalNo}`,
        narration: `Reversal of journal ${journal.JournalNo}`,
        userUID,
      };
      const reversalUID = await this.createHeader(trx, header);
      for (const entry of entries) {
        const side: JournalSide = entry.TransactionType === "Debit" ? "Credit" : "Debit";
        await this.addLine(trx, header, reversalUID, Number(entry.LedgerUID), side, Number(entry.Amount), `Reversal: ${entry.Particulars ?? ""}`);
      }
    }
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

  // Header of a record's journal; CI3 uses the calendar year of the record date as the financial year
  private static recordHeader(record: RecordJournal, referenceType: string, narration: string): JournalHeader {
    return {
      orgUID: record.orgUID,
      date: record.date,
      financialYear: Number(record.date.slice(0, 4)),
      referenceType,
      referenceID: record.recordUID,
      referenceNo: record.number || null,
      narration,
      userUID: record.userUID,
    };
  }

  // PHP date('d M Y')
  private static displayDate(ymd: string): string {
    const [y, m, d] = ymd.split("-").map(Number);
    const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
    return `${String(d).padStart(2, "0")} ${month} ${y}`;
  }
}
