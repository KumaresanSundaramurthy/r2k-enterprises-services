// Decimal places for money values in responses (CI3 MY_Controller::_decimals()).
export const AMOUNT_DECIMALS = 2;

// CI3 hard-codes an April financial year for balance rows (Accountledger::getFinancialYear,
// Customers::_currentFinancialYear). Rows both apps write must use the same year key.
export const BALANCE_FY_START_MONTH = 4;

// Modules.ModuleTbl.ModuleUID values (names as in that table), used as Transaction.TransactionsTbl.ModuleUID.
export const MODULE_UID = {
  Invoices: 103,
  SalesReturns: 106,
  CreditNotes: 107,
} as const;
