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
  salesRevenue: "SYS-SALES",
  cgstOutput: "SYS-CGST-OUT",
  sgstOutput: "SYS-SGST-OUT",
  igstOutput: "SYS-IGST-OUT",
  salaryExpense: "SYS-SALARY-EXP",
  salaryPayable: "SYS-SALARY-PAY",
  // Employee Advances (asset): Dr when an advance is approved, Cr when payroll recovers it (CI3 advance_clearing too)
  employeeAdvance: "SYS-EMP-ADV",
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

// A saved purchase bill / purchase return whose journal is posted
export interface DocumentJournal {
  orgUID: number;
  transUID: number;
  number: string | null;
  date: string;
  financialYear: number;
  netAmount: number;
  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  vendorUID: number;
  userUID: number;
}

// A saved invoice / sales return whose journal is posted
export type SaleJournal = Omit<DocumentJournal, "vendorUID"> & { customerUID: number };

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
  // referenceType: "RentalPayment" for a rental payment — CI3 posted those as IndirectIncome with the payment's UID,
  // which collides with the indirect income record of the same UID (reversing one reversed both)
  async postIndirectIncome(trx: Knex.Transaction, income: RecordJournal, referenceType: "IndirectIncome" | "RentalPayment" = "IndirectIncome"): Promise<void> {
    const net = phpRound(income.netAmount, DECIMALS);
    if (net <= 0) return;
    const ref = income.number || `#${income.recordUID}`;
    const header = JournalService.recordHeader(income, referenceType, `Indirect Income ${ref}`);
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

  // postPurchaseJournal — Dr Purchase (taxable) + Dr input CGST / SGST / IGST, Cr the vendor (net payable)
  async postPurchase(trx: Knex.Transaction, bill: DocumentJournal): Promise<void> {
    const net = phpRound(bill.netAmount, DECIMALS);
    if (net <= 0) return;
    const vendorLedger = await this.ledgers.findEntityLedger(bill.orgUID, "VendorUID", bill.vendorUID, "Vendor", trx);
    if (!vendorLedger) return;
    const ref = bill.number ?? "";
    const header = JournalService.documentHeader(bill, "Purchase", `Purchase Bill ${bill.number || "Draft"} — Vendor #${bill.vendorUID}`);
    const journalUID = await this.createHeader(trx, header);
    const purchaseLedger = await this.repo.systemLedgerUID(trx, bill.orgUID, SYSTEM_LEDGERS.purchaseCost);
    if (purchaseLedger) await this.addLine(trx, header, journalUID, purchaseLedger, "Debit", bill.taxableAmount, `Purchase of goods/services — ${ref}`);
    for (const [code, amount, label] of JournalService.inputTaxes(bill)) {
      const taxLedger = await this.repo.systemLedgerUID(trx, bill.orgUID, code);
      if (taxLedger) await this.addLine(trx, header, journalUID, taxLedger, "Debit", amount, `Input ${label} — ${ref}`);
    }
    await this.addLine(trx, header, journalUID, Number(vendorLedger.LedgerUID), "Credit", net, `Bill ${ref} — Amount Payable`);
  }

  // postPurchaseReturnJournal — Dr the vendor (net), Cr Purchase (taxable) + Cr input CGST / SGST / IGST
  async postPurchaseReturn(trx: Knex.Transaction, ret: DocumentJournal): Promise<void> {
    const net = phpRound(ret.netAmount, DECIMALS);
    if (net <= 0) return;
    const vendorLedger = await this.ledgers.findEntityLedger(ret.orgUID, "VendorUID", ret.vendorUID, "Vendor", trx);
    if (!vendorLedger) return;
    const ref = ret.number ?? "";
    const header = JournalService.documentHeader(ret, "PurchaseReturn", `Purchase Return ${ret.number || "Draft"} — Vendor #${ret.vendorUID}`);
    const journalUID = await this.createHeader(trx, header);
    await this.addLine(trx, header, journalUID, Number(vendorLedger.LedgerUID), "Debit", net, `Purchase return debit — ${ref}`);
    const purchaseLedger = await this.repo.systemLedgerUID(trx, ret.orgUID, SYSTEM_LEDGERS.purchaseCost);
    if (purchaseLedger) await this.addLine(trx, header, journalUID, purchaseLedger, "Credit", ret.taxableAmount, `Purchase return — goods/services reversed ${ref}`);
    for (const [code, amount, label] of JournalService.inputTaxes(ret)) {
      const taxLedger = await this.repo.systemLedgerUID(trx, ret.orgUID, code);
      if (taxLedger) await this.addLine(trx, header, journalUID, taxLedger, "Credit", amount, `Input ${label} reversed — ${ref}`);
    }
  }

  // postSaleJournal — Dr the customer (net receivable), Cr Sales (taxable) + Cr output CGST / SGST / IGST
  async postSale(trx: Knex.Transaction, sale: SaleJournal): Promise<void> {
    const net = phpRound(sale.netAmount, DECIMALS);
    if (net <= 0) return;
    const customerLedger = await this.ledgers.findEntityLedger(sale.orgUID, "CustomerUID", sale.customerUID, "Customer", trx);
    if (!customerLedger) return;
    const ref = sale.number ?? "";
    const header = JournalService.saleHeader(sale, "Invoice", `Sale Invoice ${sale.number || "Draft"} — Customer #${sale.customerUID}`);
    const journalUID = await this.createHeader(trx, header);
    await this.addLine(trx, header, journalUID, Number(customerLedger.LedgerUID), "Debit", net, `Invoice ${ref} — Amount Receivable`);
    const salesLedger = await this.repo.systemLedgerUID(trx, sale.orgUID, SYSTEM_LEDGERS.salesRevenue);
    if (salesLedger) await this.addLine(trx, header, journalUID, salesLedger, "Credit", sale.taxableAmount, `Sale of goods/services — ${ref}`);
    for (const [code, amount, label] of JournalService.outputTaxes(sale)) {
      const taxLedger = await this.repo.systemLedgerUID(trx, sale.orgUID, code);
      if (taxLedger) await this.addLine(trx, header, journalUID, taxLedger, "Credit", amount, `Output ${label} — ${ref}`);
    }
  }

  // postSaleReturnJournal — Dr Sales (taxable) + Dr output CGST / SGST / IGST, Cr the customer (net)
  async postSaleReturn(trx: Knex.Transaction, ret: SaleJournal): Promise<void> {
    const net = phpRound(ret.netAmount, DECIMALS);
    if (net <= 0) return;
    const customerLedger = await this.ledgers.findEntityLedger(ret.orgUID, "CustomerUID", ret.customerUID, "Customer", trx);
    if (!customerLedger) return;
    const ref = ret.number ?? "";
    const header = JournalService.saleHeader(ret, "SalesReturn", `Sales Return ${ret.number || "Draft"} — Customer #${ret.customerUID}`);
    const journalUID = await this.createHeader(trx, header);
    const salesLedger = await this.repo.systemLedgerUID(trx, ret.orgUID, SYSTEM_LEDGERS.salesRevenue);
    if (salesLedger) await this.addLine(trx, header, journalUID, salesLedger, "Debit", ret.taxableAmount, `Sales return — goods/services reversed ${ref}`);
    for (const [code, amount, label] of JournalService.outputTaxes(ret)) {
      const taxLedger = await this.repo.systemLedgerUID(trx, ret.orgUID, code);
      if (taxLedger) await this.addLine(trx, header, journalUID, taxLedger, "Debit", amount, `Output ${label} reversed — ${ref}`);
    }
    await this.addLine(trx, header, journalUID, Number(customerLedger.LedgerUID), "Credit", net, `Sales return credit — ${ref}`);
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

  // postAdvanceJournal — salary advance approved: Dr Employee Advances, Cr Accounts Payable (the cash paid out)
  async postSalaryAdvance(trx: Knex.Transaction, orgUID: number, advanceUID: number, date: string, amount: number, userUID: number): Promise<void> {
    const value = phpRound(amount, DECIMALS);
    if (value <= 0) return;
    const header: JournalHeader = {
      orgUID,
      date,
      financialYear: Number(date.slice(0, 4)),
      referenceType: "SalaryAdvance",
      referenceID: advanceUID,
      referenceNo: `ADV-${advanceUID}`,
      narration: `Salary advance approved — Advance #${advanceUID}`,
      userUID,
    };
    const journalUID = await this.createHeader(trx, header);
    const advance = await this.repo.systemLedgerUID(trx, orgUID, SYSTEM_LEDGERS.employeeAdvance);
    if (advance) await this.addLine(trx, header, journalUID, advance, "Debit", value, `Advance given to employee — #${advanceUID}`);
    const payable = await this.repo.systemLedgerUID(trx, orgUID, SYSTEM_LEDGERS.accountsPayable);
    if (payable) await this.addLine(trx, header, journalUID, payable, "Credit", value, `Cash/bank paid for advance #${advanceUID}`);
  }

  /**
   * postPayrollJournal — Dr Salary & Wages Expense (gross); Cr Salary Payable (net), Cr Employee Advances (advance
   * recovered) and Cr Accounts Payable (the other deductions). Dated the last day of the payroll month.
   */
  async postPayroll(
    trx: Knex.Transaction,
    run: { orgUID: number; payrollUID: number; date: string; monthName: string; gross: number; net: number; deductions: number; advanceRecovery: number; userUID: number }
  ): Promise<void> {
    const gross = phpRound(run.gross, DECIMALS);
    if (gross <= 0) return;
    const { orgUID, payrollUID } = run;
    const header: JournalHeader = {
      orgUID,
      date: run.date,
      financialYear: Number(run.date.slice(0, 4)),
      referenceType: "Payroll",
      referenceID: payrollUID,
      referenceNo: `PAY-${payrollUID}`,
      // CI3 named every run "January <year>" (it formatted 1 January of the year)
      narration: `Payroll processed for ${run.monthName}`,
      userUID: run.userUID,
    };
    const journalUID = await this.createHeader(trx, header);
    const ledger = (code: string) => this.repo.systemLedgerUID(trx, orgUID, code);

    const expense = await ledger(SYSTEM_LEDGERS.salaryExpense);
    if (expense) await this.addLine(trx, header, journalUID, expense, "Debit", gross, `Salary expense for payroll #${payrollUID}`);
    const payable = await ledger(SYSTEM_LEDGERS.salaryPayable);
    if (payable && run.net > 0) await this.addLine(trx, header, journalUID, payable, "Credit", run.net, `Net salary payable — payroll #${payrollUID}`);
    const advance = await ledger(SYSTEM_LEDGERS.employeeAdvance);
    if (advance && run.advanceRecovery > 0) await this.addLine(trx, header, journalUID, advance, "Credit", run.advanceRecovery, `Advance recovery — payroll #${payrollUID}`);
    const otherDeductions = phpRound(run.deductions - run.advanceRecovery, DECIMALS);
    const accountsPayable = await ledger(SYSTEM_LEDGERS.accountsPayable);
    if (accountsPayable && otherDeductions > 0) {
      await this.addLine(trx, header, journalUID, accountsPayable, "Credit", otherDeductions, `Salary deductions (PF/ESI/TDS) — payroll #${payrollUID}`);
    }
  }

  /**
   * postManualJournal — a user-entered journal ('Manual', or 'Recurring' when posted from a recurring journal).
   * Its ReferenceID / ReferenceNo point at itself. Lines must already be checked (the organisation's ledgers, balanced).
   */
  async postManual(
    trx: Knex.Transaction,
    orgUID: number,
    date: string,
    narration: string,
    lines: { LedgerUID: number; Type: JournalSide; Amount: number; Particulars: string }[],
    userUID: number,
    referenceType: "Manual" | "Recurring" = "Manual"
  ): Promise<{ journalUID: number; journalNo: string }> {
    const header: JournalHeader = { orgUID, date, financialYear: Number(date.slice(0, 4)), referenceType, referenceID: 0, referenceNo: null, narration, userUID };
    const journalUID = await this.createHeader(trx, header);
    const journalNo = `JRN-${header.financialYear}-${String(journalUID).padStart(7, "0")}`;
    await this.repo.setReference(trx, orgUID, journalUID, journalUID, journalNo);
    for (const line of lines) {
      await this.addLine(trx, header, journalUID, line.LedgerUID, line.Type, line.Amount, line.Particulars || narration);
    }
    return { journalUID, journalNo };
  }

  // reverseManualJournal — a live Manual journal is soft-deleted and a dated-today 'Reversal-Manual' journal swaps its lines
  async reverseManual(trx: Knex.Transaction, orgUID: number, journalUID: number, userUID: number, today: string = todayDate()): Promise<boolean> {
    const journal = await this.repo.liveJournal(trx, orgUID, journalUID);
    if (!journal || journal.ReferenceType !== "Manual") return false;
    const entries = await this.repo.journalEntries(trx, orgUID, journalUID);
    await this.repo.softDeleteJournal(trx, orgUID, journalUID);
    if (entries.length === 0) return true;

    const header: JournalHeader = {
      orgUID,
      date: today,
      financialYear: Number(journal.FinancialYear),
      referenceType: "Reversal-Manual",
      referenceID: journalUID,
      referenceNo: `REV-${journal.JournalNo}`,
      narration: `Reversal of ${journal.JournalNo}: ${journal.Narration ?? ""}`,
      userUID,
    };
    const reversalUID = await this.createHeader(trx, header);
    for (const entry of entries) {
      const side: JournalSide = entry.TransactionType === "Debit" ? "Credit" : "Debit";
      await this.addLine(trx, header, reversalUID, Number(entry.LedgerUID), side, Number(entry.Amount), `Reversal: ${entry.Particulars ?? ""}`);
    }
    return true;
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

  /**
   * _writeBankLedgerEntry — non-fatal, as in CI3: a failure is logged and the caller carries on. With trx the line
   * is written in the caller's transaction (CI3 writes it inside the open document transaction).
   */
  async writeBankLedgerEntry(entry: BankLedgerEntry, trx?: Knex.Transaction): Promise<void> {
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
      }, trx);
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

  // Header of a purchase / purchase return journal; the financial year is the document's (calendar year of its date)
  private static documentHeader(doc: DocumentJournal, referenceType: string, narration: string): JournalHeader {
    return {
      orgUID: doc.orgUID,
      date: doc.date,
      financialYear: doc.financialYear,
      referenceType,
      referenceID: doc.transUID,
      referenceNo: doc.number || null,
      narration,
      userUID: doc.userUID,
    };
  }

  // The input-tax lines a purchase document carries (only the non-zero ones are posted)
  private static saleHeader(doc: SaleJournal, referenceType: string, narration: string): JournalHeader {
    return { orgUID: doc.orgUID, date: doc.date, financialYear: doc.financialYear, referenceType, referenceID: doc.transUID, referenceNo: doc.number || null, narration, userUID: doc.userUID };
  }

  // The output-tax lines a sales document carries (only the non-zero ones are posted)
  private static outputTaxes(doc: SaleJournal) {
    return (
      [
        [SYSTEM_LEDGERS.cgstOutput, doc.cgst, "CGST"],
        [SYSTEM_LEDGERS.sgstOutput, doc.sgst, "SGST"],
        [SYSTEM_LEDGERS.igstOutput, doc.igst, "IGST"],
      ] as const
    ).filter(([, amount]) => phpRound(amount, DECIMALS) > 0);
  }

  private static inputTaxes(doc: DocumentJournal) {
    return (
      [
        [SYSTEM_LEDGERS.cgstInput, doc.cgst, "CGST"],
        [SYSTEM_LEDGERS.sgstInput, doc.sgst, "SGST"],
        [SYSTEM_LEDGERS.igstInput, doc.igst, "IGST"],
      ] as const
    ).filter(([, amount]) => phpRound(amount, DECIMALS) > 0);
  }

  // PHP date('d M Y')
  private static displayDate(ymd: string): string {
    const [y, m, d] = ymd.split("-").map(Number);
    const month = new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
    return `${String(d).padStart(2, "0")} ${month} ${y}`;
  }
}
