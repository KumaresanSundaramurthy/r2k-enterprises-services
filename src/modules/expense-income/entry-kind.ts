/**
 * What differs between an expense and an indirect income record where the two pages share code
 * (payments, the bank / cash book, attachments, categories).
 */
export interface EntryKind {
  // ExpenseIncomeAttachmentsTbl / PaymentsTbl SourceType and the journal's ReferenceType
  sourceType: "Expense" | "IndirectIncome";
  // ModuleUID of the records and of their payments
  moduleUID: number;
  // PaymentsTbl.PaymentModuleUID: 111 Payment Out, 110 Payment In
  paymentModuleUID: number;
  // Module whose prefix numbers the payments (CI3: the expense module itself, Payment In for income)
  prefixModuleUID: number;
  direction: "Out" | "In";
  // AccountLedgerTbl entry: money leaves (DR) or comes in (CR)
  bankEntryType: "DR" | "CR";
  // Storage folder of the record's attachments
  attachFolder: string;
}

export const EXPENSE: EntryKind = {
  sourceType: "Expense",
  moduleUID: 114,
  paymentModuleUID: 111,
  prefixModuleUID: 114,
  direction: "Out",
  bankEntryType: "DR",
  attachFolder: "expenses",
};

export const INDIRECT_INCOME: EntryKind = {
  sourceType: "IndirectIncome",
  moduleUID: 115,
  paymentModuleUID: 110,
  prefixModuleUID: 110,
  direction: "In",
  bankEntryType: "CR",
  attachFolder: "indirectincome",
};

// CI3 MY_Controller::_decimals
export const AMOUNT_DECIMALS = 2;
