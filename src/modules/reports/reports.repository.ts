import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

export type GroupBy = "month" | "quarter" | "year";

// _periodExpr — the period label rows are grouped by (fixed SQL, chosen from a whitelist)
const PERIOD: Record<GroupBy, string> = {
  month: "DATE_FORMAT(TransDate,'%Y-%m')",
  quarter: "CONCAT(YEAR(TransDate),'-Q',QUARTER(TransDate))",
  year: "CAST(YEAR(TransDate) AS CHAR)",
};

// Documents that count in the reports: live, not draft / cancelled / rejected
const LIVE_DOCS = "IsDeleted = 0 AND IsActive = 1 AND DocStatus NOT IN ('Draft','Cancelled','Rejected')";

/** The report queries of CI3 Reports_model, one method per report (same SQL, same column names). */
@Injectable()
export class ReportsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  private async rows(sql: string, bindings: (string | number)[]): Promise<Row[]> {
    const [rows] = await this.read.raw(sql, bindings);
    return rows as Row[];
  }

  // getSalesSummaryData (Invoice 103 / Sales Return 106) and getPurchaseSummaryData (Purchase 105 / Purchase Return 108)
  async tradeSummary(orgUID: number, moduleUIDs: [number, number], from: string, to: string, groupBy: GroupBy): Promise<Row[]> {
    const pe = PERIOD[groupBy];
    return this.rows(
      `SELECT ${pe}                         AS Period,
              ModuleUID,
              COUNT(DISTINCT TransUID)       AS TxCount,
              COALESCE(SUM(SubTotal),  0)    AS SubTotalAmt,
              COALESCE(SUM(TaxAmount), 0)    AS TaxAmt,
              COALESCE(SUM(NetAmount), 0)    AS NetAmt,
              MIN(TransDate)                 AS FirstDate
         FROM Transaction.TransactionsTbl
        WHERE OrgUID = ?
          AND ModuleUID IN (?, ?)
          AND ${LIVE_DOCS}
          AND TransDate BETWEEN ? AND ?
        GROUP BY ${pe}, ModuleUID
        ORDER BY MIN(TransDate), ModuleUID`,
      [orgUID, moduleUIDs[0], moduleUIDs[1], from, to]
    );
  }

  // getMonthlySummaryData — Invoice, Purchase, Sales Return and Purchase Return per calendar month
  async monthlySummary(orgUID: number, from: string, to: string): Promise<Row[]> {
    return this.rows(
      `SELECT DATE_FORMAT(TransDate,'%Y-%m') AS Period,
              MONTH(TransDate)               AS Mo,
              ModuleUID,
              COUNT(DISTINCT TransUID)       AS TxCount,
              COALESCE(SUM(NetAmount), 0)    AS NetAmt
         FROM Transaction.TransactionsTbl
        WHERE OrgUID = ?
          AND ModuleUID IN (103, 105, 106, 108)
          AND ${LIVE_DOCS}
          AND TransDate BETWEEN ? AND ?
        GROUP BY DATE_FORMAT(TransDate,'%Y-%m'), MONTH(TransDate), ModuleUID
        ORDER BY Period, ModuleUID`,
      [orgUID, from, to]
    );
  }

  // _getBillwiseItemData — every line of the module's documents in the range with its party (newest first, max 3000)
  async billwiseItems(orgUID: number, moduleUID: number, partyType: "C" | "S", from: string, to: string): Promise<Row[]> {
    return this.rows(
      `SELECT Ts.UniqueNumber                                                   AS DocNo,
              Ts.TransDate,
              Party.Name                                                        AS PartyName,
              Tprod.ProductName                                                 AS ItemName,
              Tprod.Quantity,
              Tprod.PrimaryUnitName                                             AS UnitName,
              Tprod.UnitPrice,
              COALESCE(Tprod.TaxableAmount, Tprod.Quantity * Tprod.UnitPrice)  AS TaxableAmount,
              COALESCE(Tprod.TaxPercentage, 0)                                 AS TaxPercentage,
              COALESCE(Tprod.TaxAmount,
                  COALESCE(Tprod.CgstAmount,0) + COALESCE(Tprod.SgstAmount,0) + COALESCE(Tprod.IgstAmount,0)
              )                                                                 AS TaxAmount,
              COALESCE(Tprod.DiscountAmount, 0)                                AS DiscountAmount,
              COALESCE(Tprod.NetAmount,
                  COALESCE(Tprod.TaxableAmount, Tprod.Quantity * Tprod.UnitPrice)
                  + COALESCE(Tprod.TaxAmount,
                      COALESCE(Tprod.CgstAmount,0)+COALESCE(Tprod.SgstAmount,0)+COALESCE(Tprod.IgstAmount,0))
                  - COALESCE(Tprod.DiscountAmount,0)
              )                                                                 AS NetAmount
         FROM Transaction.TransProductsTbl AS Tprod
         JOIN Transaction.TransactionsTbl  AS Ts
              ON  Ts.TransUID  = Tprod.TransUID
              AND Ts.OrgUID    = Tprod.OrgUID
              AND Ts.ModuleUID = ?
              AND Ts.IsDeleted = 0
              AND Ts.IsActive  = 1
              AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
              AND Ts.TransDate BETWEEN ? AND ?
         ${ReportsRepository.partyJoin(partyType)}
        WHERE Tprod.OrgUID    = ?
          AND Tprod.IsDeleted = 0
          AND Tprod.IsActive  = 1
        ORDER BY Ts.TransDate DESC, Ts.TransUID DESC, Tprod.ItemSequence ASC
        LIMIT 3000`,
      [moduleUID, from, to, orgUID]
    );
  }

  // _getTransRegisterData — one row per document of the module with its tax breakup (newest first, max 2000)
  async transRegister(orgUID: number, moduleUID: number, partyType: "C" | "S", from: string, to: string): Promise<Row[]> {
    return this.rows(
      `SELECT Ts.UniqueNumber             AS DocNo,
              Ts.TransDate,
              COALESCE(Party.Name, '—')   AS PartyName,
              COALESCE(Ts.SubTotal,   0)  AS Taxable,
              COALESCE(Ts.CgstAmount, 0)  AS CgstAmount,
              COALESCE(Ts.SgstAmount, 0)  AS SgstAmount,
              COALESCE(Ts.IgstAmount, 0)  AS IgstAmount,
              COALESCE(Ts.TaxAmount,  0)  AS TaxAmount,
              COALESCE(Ts.RoundOff,   0)  AS RoundOff,
              COALESCE(Ts.NetAmount,  0)  AS NetAmount,
              Ts.DocStatus
         FROM Transaction.TransactionsTbl AS Ts
         ${ReportsRepository.partyJoin(partyType)}
        WHERE Ts.OrgUID    = ?
          AND Ts.ModuleUID = ?
          AND Ts.IsDeleted = 0
          AND Ts.IsActive  = 1
          AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
          AND Ts.TransDate BETWEEN ? AND ?
        ORDER BY Ts.TransDate DESC, Ts.TransUID DESC
        LIMIT 2000`,
      [orgUID, moduleUID, from, to]
    );
  }

  // getExpenseRegisterData — committed expenses in the range (newest first, max 2000)
  async expenseRegister(orgUID: number, from: string, to: string): Promise<Row[]> {
    return this.rows(
      `SELECT e.ExpenseNumber                AS DocNo,
              e.ExpenseDate                  AS TransDate,
              COALESCE(v.Name,         '—')  AS VendorName,
              COALESCE(ec.CategoryName, '—') AS CategoryName,
              COALESCE(e.Amount,       0)    AS Amount,
              COALESCE(e.TaxAmount,    0)    AS TaxAmount,
              COALESCE(e.NetAmount,    0)    AS NetAmount,
              e.DocStatus,
              COALESCE(e.IsPaid, 0)          AS IsPaid
         FROM Transaction.ExpensesTbl e
         LEFT JOIN Transaction.ExpenseCategoryTbl ec ON ec.CategoryUID = e.CategoryUID AND ec.IsDeleted = 0
         LEFT JOIN Vendors.VendorTbl v               ON v.VendorUID = e.VendorUID
        WHERE e.OrgUID    = ?
          AND e.IsDeleted = 0
          AND e.DocStatus NOT IN ('Draft','Cancelled')
          AND e.ExpenseDate BETWEEN ? AND ?
        ORDER BY e.ExpenseDate DESC, e.ExpenseUID DESC
        LIMIT 2000`,
      [orgUID, from, to]
    );
  }

  // ── Tax reports ───────────────────────────────────────────────────────────

  // Document tax columns shared by the GST lists
  private static readonly TAX_COLUMNS = `COALESCE(Ts.SubTotal,   0) AS Taxable,
              COALESCE(Ts.CgstAmount, 0) AS CgstAmount,
              COALESCE(Ts.SgstAmount, 0) AS SgstAmount,
              COALESCE(Ts.IgstAmount, 0) AS IgstAmount,
              COALESCE(Ts.TaxAmount,  0) AS TaxAmount,
              COALESCE(Ts.NetAmount,  0) AS NetAmount`;

  // The month's live documents of a module
  private static monthDocs(moduleUID: number): string {
    return `Ts.OrgUID = ? AND Ts.ModuleUID = ${moduleUID} AND Ts.IsDeleted = 0 AND Ts.IsActive = 1
          AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
          AND MONTH(Ts.TransDate) = ? AND YEAR(Ts.TransDate) = ?`;
  }

  // getGstr1Data — the month's B2B invoices (GSTIN customers), B2CS invoices (no GSTIN) and CDNR returns (GSTIN customers)
  async gstr1(orgUID: number, month: number, year: number): Promise<{ b2b: Row[]; b2cs: Row[]; cdnr: Row[] }> {
    const b = [orgUID, month, year];
    const placeOfSupply = "LEFT JOIN Transaction.TransDetailTbl Td ON Td.TransUID = Ts.TransUID AND Td.FinancialYear = YEAR(Ts.TransDate)";
    const [b2b, b2cs, cdnr] = await Promise.all([
      this.rows(
        `SELECT Ts.UniqueNumber AS InvNo, Ts.TransDate,
                COALESCE(Cust.GSTIN, '') AS RecipientGSTIN,
                COALESCE(Cust.Name,  '—') AS RecipientName,
                COALESCE(Td.PlaceOfSupplyCode, '') AS PlaceOfSupply,
                ${ReportsRepository.TAX_COLUMNS}
           FROM Transaction.TransactionsTbl Ts
           JOIN Customers.CustomerTbl Cust ON Cust.CustomerUID = Ts.PartyUID AND Ts.PartyType = 'C' AND Cust.GSTIN IS NOT NULL AND Cust.GSTIN != ''
           ${placeOfSupply}
          WHERE ${ReportsRepository.monthDocs(103)}
          ORDER BY Ts.TransDate DESC, Ts.TransUID DESC LIMIT 2000`,
        b
      ),
      this.rows(
        `SELECT Ts.UniqueNumber AS InvNo, Ts.TransDate,
                COALESCE(Cust.Name, '—') AS CustomerName,
                COALESCE(Td.PlaceOfSupplyCode, '') AS PlaceOfSupply,
                ${ReportsRepository.TAX_COLUMNS}
           FROM Transaction.TransactionsTbl Ts
           LEFT JOIN Customers.CustomerTbl Cust ON Cust.CustomerUID = Ts.PartyUID AND Ts.PartyType = 'C'
           ${placeOfSupply}
          WHERE ${ReportsRepository.monthDocs(103)}
            AND (Cust.GSTIN IS NULL OR Cust.GSTIN = '')
          ORDER BY Ts.TransDate DESC, Ts.TransUID DESC LIMIT 2000`,
        b
      ),
      this.rows(
        `SELECT Ts.UniqueNumber AS DocNo, Ts.TransDate,
                COALESCE(Cust.GSTIN, '') AS RecipientGSTIN,
                COALESCE(Cust.Name,  '—') AS RecipientName,
                ${ReportsRepository.TAX_COLUMNS}
           FROM Transaction.TransactionsTbl Ts
           JOIN Customers.CustomerTbl Cust ON Cust.CustomerUID = Ts.PartyUID AND Ts.PartyType = 'C' AND Cust.GSTIN IS NOT NULL AND Cust.GSTIN != ''
          WHERE ${ReportsRepository.monthDocs(106)}
          ORDER BY Ts.TransDate DESC, Ts.TransUID DESC LIMIT 1000`,
        b
      ),
    ]);
    return { b2b, b2cs, cdnr };
  }

  // getGstr2bData — the month's purchase bills from GSTIN vendors
  async gstr2b(orgUID: number, month: number, year: number): Promise<Row[]> {
    return this.rows(
      `SELECT Ts.UniqueNumber AS BillNo, Ts.TransDate,
              COALESCE(Vend.GSTIN, '') AS SupplierGSTIN,
              COALESCE(Vend.Name,  '—') AS SupplierName,
              COALESCE(Td.PlaceOfSupplyCode, '') AS PlaceOfSupply,
              ${ReportsRepository.TAX_COLUMNS},
              Ts.DocStatus
         FROM Transaction.TransactionsTbl Ts
         JOIN Vendors.VendorTbl Vend ON Vend.VendorUID = Ts.PartyUID AND Ts.PartyType = 'S' AND Vend.GSTIN IS NOT NULL AND Vend.GSTIN != ''
         LEFT JOIN Transaction.TransDetailTbl Td ON Td.TransUID = Ts.TransUID AND Td.FinancialYear = YEAR(Ts.TransDate)
        WHERE ${ReportsRepository.monthDocs(105)}
        ORDER BY Ts.TransDate DESC, Ts.TransUID DESC LIMIT 2000`,
      [orgUID, month, year]
    );
  }

  // getGstr3bData — the month's outward totals (invoices less returns) and ITC (purchases, purchase-return reversals)
  async gstr3b(orgUID: number, month: number, year: number): Promise<{ outward: Row; itc: Row }> {
    const sum = (module: number, column: string, alias: string) => `SUM(CASE WHEN ModuleUID = ${module} THEN COALESCE(${column}, 0) ELSE 0 END) AS ${alias}`;
    const count = (module: number, alias: string) => `COUNT(CASE WHEN ModuleUID = ${module} THEN 1 END) AS ${alias}`;
    const where = (modules: string) => `FROM Transaction.TransactionsTbl
        WHERE OrgUID = ? AND ModuleUID IN (${modules}) AND IsDeleted = 0 AND IsActive = 1
          AND DocStatus NOT IN ('Draft','Cancelled','Rejected')
          AND MONTH(TransDate) = ? AND YEAR(TransDate) = ?`;
    const b = [orgUID, month, year];
    const [outward, itc] = await Promise.all([
      this.rows(
        `SELECT ${[
          sum(103, "SubTotal", "SalesTaxable"), sum(103, "CgstAmount", "SalesCgst"), sum(103, "SgstAmount", "SalesSgst"), sum(103, "IgstAmount", "SalesIgst"),
          sum(103, "TaxAmount", "SalesTax"), sum(103, "NetAmount", "SalesNet"), count(103, "SalesCount"),
          sum(106, "SubTotal", "ReturnTaxable"), sum(106, "CgstAmount", "ReturnCgst"), sum(106, "SgstAmount", "ReturnSgst"), sum(106, "IgstAmount", "ReturnIgst"),
          sum(106, "TaxAmount", "ReturnTax"), count(106, "ReturnCount"),
        ].join(",\n               ")}
         ${where("103, 106")}`,
        b
      ),
      this.rows(
        `SELECT ${[
          sum(105, "SubTotal", "PurchaseTaxable"), sum(105, "CgstAmount", "PurchaseCgst"), sum(105, "SgstAmount", "PurchaseSgst"), sum(105, "IgstAmount", "PurchaseIgst"),
          sum(105, "TaxAmount", "PurchaseTax"), sum(105, "NetAmount", "PurchaseNet"), count(105, "PurchaseCount"),
          sum(108, "CgstAmount", "PRCgst"), sum(108, "SgstAmount", "PRSgst"), sum(108, "IgstAmount", "PRIgst"),
        ].join(",\n               ")}
         ${where("105, 108")}`,
        b
      ),
    ]);
    return { outward: outward[0] ?? {}, itc: itc[0] ?? {} };
  }

  // getGstr7Data / getTdsPayableData — expenses with TDS in the range (newest first, max 1000)
  async tdsExpenses(orgUID: number, from: string, to: string): Promise<Row[]> {
    return this.rows(
      `SELECT e.ExpenseNumber AS DocNo, e.ExpenseDate AS TransDate,
              COALESCE(v.Name,         '—') AS VendorName,
              COALESCE(v.GSTIN,        '')  AS VendorGSTIN,
              COALESCE(ts.SectionCode, '—') AS TdsSection,
              COALESCE(ts.Description, '—') AS TdsSectionDesc,
              COALESCE(e.Amount,        0)  AS BaseAmount,
              COALESCE(e.TDSPercentage, 0)  AS TdsPct,
              COALESCE(e.TDSAmount,     0)  AS TdsAmount,
              COALESCE(e.NetAmount,     0)  AS NetAmount,
              e.DocStatus, COALESCE(e.IsPaid, 0) AS IsPaid
         FROM Transaction.ExpensesTbl e
         LEFT JOIN Vendors.VendorTbl v     ON v.VendorUID = e.VendorUID
         LEFT JOIN Global.TdsSectionTbl ts ON ts.TdsSectionUID = e.TdsSectionUID
        WHERE e.OrgUID = ? AND e.IsDeleted = 0 AND e.TDSApplicable = 1
          AND e.DocStatus NOT IN ('Draft','Cancelled')
          AND e.ExpenseDate BETWEEN ? AND ?
        ORDER BY e.ExpenseDate DESC, e.ExpenseUID DESC LIMIT 1000`,
      [orgUID, from, to]
    );
  }

  // getHsnSummaryData — invoice lines per HSN / SAC code, tax rate and unit (largest first, max 1000)
  async hsnSummary(orgUID: number, from: string, to: string): Promise<Row[]> {
    return this.rows(
      `SELECT COALESCE(Prod.HSNSACCode, 'N/A')                                      AS HsnCode,
              COALESCE(Unit.ShortName,  'PCS')                                      AS UOM,
              COALESCE(Tprod.TaxPercentage, 0)                                      AS TaxRate,
              SUM(Tprod.Quantity)                                                   AS TotalQty,
              SUM(COALESCE(Tprod.TaxableAmount, Tprod.Quantity * Tprod.UnitPrice))  AS TaxableValue,
              SUM(COALESCE(Tprod.CgstAmount, 0))                                    AS CgstAmount,
              SUM(COALESCE(Tprod.SgstAmount, 0))                                    AS SgstAmount,
              SUM(COALESCE(Tprod.IgstAmount, 0))                                    AS IgstAmount,
              SUM(COALESCE(Tprod.TaxAmount,
                  COALESCE(Tprod.CgstAmount,0) + COALESCE(Tprod.SgstAmount,0) + COALESCE(Tprod.IgstAmount,0)
              ))                                                                    AS TaxAmount,
              COUNT(DISTINCT Ts.TransUID)                                           AS InvCount
         FROM Transaction.TransProductsTbl AS Tprod
         JOIN Transaction.TransactionsTbl  AS Ts
              ON  Ts.TransUID = Tprod.TransUID AND Ts.OrgUID = Tprod.OrgUID
              AND Ts.ModuleUID = 103 AND Ts.IsDeleted = 0 AND Ts.IsActive = 1
              AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
              AND Ts.TransDate BETWEEN ? AND ?
         JOIN Products.ProductTbl Prod        ON Prod.ProductUID = Tprod.ProductUID
         LEFT JOIN Global.PrimaryUnitTbl Unit ON Unit.PrimaryUnitUID = Prod.PrimaryUnitUID
        WHERE Tprod.OrgUID = ? AND Tprod.IsDeleted = 0 AND Tprod.IsActive = 1
        GROUP BY COALESCE(Prod.HSNSACCode,'N/A'), COALESCE(Tprod.TaxPercentage,0), COALESCE(Unit.ShortName,'PCS')
        ORDER BY TaxableValue DESC
        LIMIT 1000`,
      [from, to, orgUID]
    );
  }

  // getTdsReceivableData — invoices of ₹30,000 or more in the range (where a customer may deduct TDS)
  async tdsReceivable(orgUID: number, from: string, to: string): Promise<Row[]> {
    return this.rows(
      `SELECT Ts.UniqueNumber AS InvNo, Ts.TransDate,
              COALESCE(Cust.Name,  '—') AS CustomerName,
              COALESCE(Cust.GSTIN, '')  AS CustomerGSTIN,
              COALESCE(Ts.SubTotal,  0) AS Taxable,
              COALESCE(Ts.TaxAmount, 0) AS TaxAmount,
              COALESCE(Ts.NetAmount, 0) AS NetAmount,
              Ts.DocStatus
         FROM Transaction.TransactionsTbl Ts
         LEFT JOIN Customers.CustomerTbl Cust ON Cust.CustomerUID = Ts.PartyUID AND Ts.PartyType = 'C'
        WHERE Ts.OrgUID = ? AND Ts.ModuleUID = 103 AND Ts.IsDeleted = 0 AND Ts.IsActive = 1
          AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
          AND Ts.NetAmount >= 30000
          AND Ts.TransDate BETWEEN ? AND ?
        ORDER BY Ts.TransDate DESC, Ts.TransUID DESC LIMIT 1000`,
      [orgUID, from, to]
    );
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  /**
   * Ledger totals for P&L / balance sheet / trial balance. Fixes two CI3 errors (same fix as api/accounting):
   * an entry counts only when its journal passed the date filter (CI3 summed every entry, so the date range did
   * nothing), and reversal journals are left out (CI3 counted them while their deleted originals were not).
   */
  private async ledgerTotals(orgUID: number, opts: { dateSql: string; dateBindings: string[]; types?: string[]; withOpening: boolean; drAlias: string; crAlias: string; having?: string }): Promise<Row[]> {
    const side = (type: string, alias: string) => `COALESCE(SUM(CASE WHEN gj.JournalUID IS NOT NULL AND je.TransactionType = '${type}' THEN je.Amount ELSE 0 END), 0) AS ${alias}`;
    const types = opts.types ?? [];
    return this.rows(
      `SELECT ca.LedgerUID, ca.LedgerCode, ca.LedgerName, ca.LedgerType,
              ${opts.withOpening ? "ca.OpeningBalance, ca.OpeningBalanceType," : ""}
              ${side("Debit", opts.drAlias)},
              ${side("Credit", opts.crAlias)}
         FROM Accounting.ChartOfAccounts ca
         LEFT JOIN Accounting.JournalEntries je ON je.LedgerUID = ca.LedgerUID AND je.IsDeleted = 0 AND je.OrgUID = ?
         LEFT JOIN Accounting.GeneralJournal gj ON gj.JournalUID = je.JournalUID AND gj.IsDeleted = 0 AND gj.OrgUID = ?
              AND COALESCE(gj.ReferenceType, '') NOT LIKE 'Reversal-%'
              AND ${opts.dateSql}
        WHERE ca.OrgUID = ? AND ca.IsDeleted = 0
          ${types.length ? `AND ca.LedgerType IN (${types.map(() => "?").join(", ")})` : ""}
        GROUP BY ca.LedgerUID
        ${opts.having ? `HAVING ${opts.having}` : ""}
        ORDER BY ca.LedgerType, ca.LedgerName`,
      [orgUID, orgUID, ...opts.dateBindings, orgUID, ...types]
    );
  }

  // getPLStatementData — Income / Expense ledgers with the period's debits and credits
  async plStatement(orgUID: number, from: string, to: string): Promise<Row[]> {
    return this.ledgerTotals(orgUID, { dateSql: "gj.JournalDate BETWEEN ? AND ?", dateBindings: [from, to], types: ["Income", "Expense"], withOpening: false, drAlias: "PeriodDebit", crAlias: "PeriodCredit" });
  }

  // getBalanceSheetData — balance-sheet and P&L ledgers with opening balance and everything up to the date
  async balanceSheet(orgUID: number, asOf: string): Promise<Row[]> {
    return this.ledgerTotals(orgUID, {
      dateSql: "gj.JournalDate <= ?",
      dateBindings: [asOf],
      types: ["Asset", "Liability", "Income", "Expense", "Bank", "Cash", "Customer", "Vendor"],
      withOpening: true,
      drAlias: "TotalDebit",
      crAlias: "TotalCredit",
    });
  }

  // getTrialBalanceReportData — ledgers with activity in the period or an opening balance
  async trialBalance(orgUID: number, from: string, to: string): Promise<Row[]> {
    return this.ledgerTotals(orgUID, {
      dateSql: "gj.JournalDate BETWEEN ? AND ?",
      dateBindings: [from, to],
      withOpening: true,
      drAlias: "PeriodDebit",
      crAlias: "PeriodCredit",
      having: "PeriodDebit > 0 OR PeriodCredit > 0 OR ca.OpeningBalance > 0",
    });
  }

  // getBankStatementData — payments in the range, all accounts or one (0 = all), oldest first (max 2000)
  async bankStatement(orgUID: number, from: string, to: string, accountUID: number): Promise<Row[]> {
    return this.rows(
      `SELECT P.PaymentUID,
              P.UniqueNumber,
              P.PaymentDate,
              P.Amount,
              P.PartyType,
              P.ReferenceNo,
              COALESCE(Cust.Name, Vend.Name, '—') AS PartyName,
              COALESCE(PT.Name,  'Cash')          AS PaymentMode,
              COALESCE(PT.IsCash, 1)              AS IsCash,
              COALESCE(BA.AccountName, 'Cash')    AS AccountName,
              COALESCE(BA.BankName,    '')        AS BankName
         FROM Transaction.PaymentsTbl P
         LEFT JOIN Customers.CustomerTbl           Cust ON Cust.CustomerUID  = P.PartyUID AND P.PartyType = 'C'
         LEFT JOIN Vendors.VendorTbl               Vend ON Vend.VendorUID    = P.PartyUID AND P.PartyType = 'S'
         LEFT JOIN Global.PaymentTypesTbl          PT   ON PT.PaymentTypeUID = P.PaymentTypeUID
         LEFT JOIN Organisation.OrgBankAccountsTbl BA   ON BA.BankAccountUID = P.BankAccountUID
        WHERE P.OrgUID = ? AND P.IsDeleted = 0 AND P.IsActive = 1 AND P.IsCancelled = 0
          AND P.PaymentDate BETWEEN ? AND ?
          ${accountUID > 0 ? "AND P.BankAccountUID = ?" : ""}
        ORDER BY P.PaymentDate ASC, P.PaymentUID ASC
        LIMIT 2000`,
      accountUID > 0 ? [orgUID, from, to, accountUID] : [orgUID, from, to]
    );
  }

  // getBankAccounts — the org's active accounts for the bank statement's account picker (cash first)
  async bankAccounts(orgUID: number): Promise<Row[]> {
    return this.rows(
      `SELECT BankAccountUID, AccountName, BankName, IsCash
         FROM Organisation.OrgBankAccountsTbl
        WHERE OrgUID = ? AND IsDeleted = 0 AND IsActive = 1
        ORDER BY IsCash DESC, AccountName ASC`,
      [orgUID]
    );
  }

  // Transactions_model::getDayBookEntries — the day's documents and payments, newest first
  async dayBook(orgUID: number, date: string): Promise<Row[]> {
    return this.rows(
      `SELECT Ts.TransUID AS EntryUID, 'transaction' AS Source, Ts.TransType AS TransType, Ts.UniqueNumber AS SerialNumber,
              Ts.NetAmount AS Amount, Ts.DocStatus AS DocStatus, Ts.PartyType AS PartyType, Ts.ModuleUID AS ModuleUID,
              Ts.TransToken AS TransToken, Ts.TransUID AS TransUID, Ts.CreatedOn AS EntryTime,
              COALESCE(Cust.Name, Vend.Name) AS PartyName, COALESCE(Cust.Area, Vend.Area) AS PartyArea,
              COALESCE(Cust.MobileNumber, Vend.MobileNumber) AS MobileNumber, COALESCE(Cust.CountryCode, Vend.CountryCode) AS CountryCode,
              NULL AS PaymentMode, NULL AS ReceiptToken
         FROM Transaction.TransactionsTbl Ts
         LEFT JOIN Customers.CustomerTbl AS Cust ON Cust.CustomerUID = Ts.PartyUID AND Ts.PartyType = 'C'
         LEFT JOIN Vendors.VendorTbl     AS Vend ON Vend.VendorUID   = Ts.PartyUID AND Ts.PartyType = 'S'
        WHERE Ts.OrgUID = ? AND Ts.TransDate = ? AND Ts.IsDeleted = 0 AND Ts.IsActive = 1
          AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
       UNION ALL
       SELECT P.PaymentUID, 'payment', CASE WHEN P.PartyType = 'C' THEN 'Payment In' ELSE 'Payment Out' END, P.UniqueNumber,
              P.Amount, 'Paid', P.PartyType, P.ModuleUID, NULL, P.TransUID, P.CreatedOn,
              COALESCE(Cust.Name, Vend.Name), COALESCE(Cust.Area, Vend.Area),
              COALESCE(Cust.MobileNumber, Vend.MobileNumber), COALESCE(Cust.CountryCode, Vend.CountryCode),
              PT.Name, P.ReceiptToken
         FROM Transaction.PaymentsTbl P
         LEFT JOIN Global.PaymentTypesTbl AS PT   ON PT.PaymentTypeUID = P.PaymentTypeUID
         LEFT JOIN Customers.CustomerTbl  AS Cust ON Cust.CustomerUID  = P.PartyUID AND P.PartyType = 'C'
         LEFT JOIN Vendors.VendorTbl      AS Vend ON Vend.VendorUID    = P.PartyUID AND P.PartyType = 'S'
        WHERE P.OrgUID = ? AND P.PaymentDate = ? AND P.IsDeleted = 0 AND P.IsActive = 1
        ORDER BY EntryTime DESC`,
      [orgUID, date, orgUID, date]
    );
  }

  // ── Stock / item reports ──────────────────────────────────────────────────

  // getItemWiseSalesData (invoices, 103) / getItemWisePurchaseData (purchases, 105) — per product, largest first (max 1000)
  async itemTotals(orgUID: number, kind: "sales" | "purchase", from: string, to: string): Promise<Row[]> {
    const [moduleUID, value, avg, count] = kind === "sales" ? [103, "TotalValue", "AvgPrice", "InvoiceCount"] : [105, "TotalCost", "AvgCost", "BillCount"];
    return this.rows(
      `SELECT Prod.ProductUID,
              Prod.ItemName,
              Prod.SKU,
              Cat.Name                              AS CategoryName,
              Unit.ShortName                        AS UnitName,
              SUM(Tprod.Quantity)                   AS TotalQty,
              SUM(Tprod.Quantity * Tprod.UnitPrice) AS ${value},
              AVG(Tprod.UnitPrice)                  AS ${avg},
              COUNT(DISTINCT Ts.TransUID)           AS ${count}
         FROM Transaction.TransProductsTbl AS Tprod
         JOIN Transaction.TransactionsTbl  AS Ts
              ON  Ts.TransUID  = Tprod.TransUID
              AND Ts.OrgUID    = Tprod.OrgUID
              AND Ts.ModuleUID = ${moduleUID}
              AND Ts.IsDeleted = 0
              AND Ts.IsActive  = 1
              AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
              AND Ts.TransDate BETWEEN ? AND ?
         JOIN Products.ProductTbl AS Prod        ON Prod.ProductUID = Tprod.ProductUID
         LEFT JOIN Products.CategoryTbl AS Cat   ON Cat.CategoryUID = Prod.CategoryUID
         LEFT JOIN Global.PrimaryUnitTbl AS Unit ON Unit.PrimaryUnitUID = Prod.PrimaryUnitUID
        WHERE Tprod.OrgUID = ? AND Tprod.IsDeleted = 0 AND Tprod.IsActive = 1
        GROUP BY Prod.ProductUID
        ORDER BY ${value} DESC
        LIMIT 1000`,
      [from, to, orgUID]
    );
  }

  // getLowStockAlertData — stocked products at or below their alert level, biggest shortfall first (max 500)
  async lowStock(orgUID: number): Promise<Row[]> {
    return this.rows(
      `SELECT Prod.ProductUID,
              Prod.ItemName,
              Prod.SKU,
              Cat.Name                     AS CategoryName,
              Unit.ShortName               AS UnitName,
              COALESCE(PS.AvailableQty, 0) AS AvailableQty,
              Prod.LowStockAlertAt,
              Prod.PurchasePrice,
              (Prod.LowStockAlertAt - COALESCE(PS.AvailableQty, 0)) AS ShortfallQty
         FROM Products.ProductTbl AS Prod
         LEFT JOIN Products.ProductStockTbl AS PS ON PS.ProductUID = Prod.ProductUID
         LEFT JOIN Products.CategoryTbl AS Cat    ON Cat.CategoryUID = Prod.CategoryUID
         LEFT JOIN Global.PrimaryUnitTbl AS Unit  ON Unit.PrimaryUnitUID = Prod.PrimaryUnitUID
        WHERE Prod.OrgUID = ?
          AND Prod.IsDeleted = 0
          AND Prod.IsActive = 1
          AND Prod.ProductType = 'Product'
          AND Prod.IsComposite = 0
          AND Prod.LowStockAlertAt > 0
          AND COALESCE(PS.AvailableQty, 0) <= Prod.LowStockAlertAt
        ORDER BY ShortfallQty DESC
        LIMIT 500`,
      [orgUID]
    );
  }

  // getStockSummaryData — every stocked product with its quantity and value at purchase price (max 2000)
  async stockSummary(orgUID: number): Promise<Row[]> {
    return this.rows(
      `SELECT Prod.ProductUID,
              Prod.ItemName,
              Prod.SKU,
              Cat.Name                                          AS CategoryName,
              Unit.ShortName                                    AS UnitName,
              Prod.PurchasePrice,
              Prod.SellingPrice,
              Prod.LowStockAlertAt,
              COALESCE(PS.AvailableQty, 0)                      AS AvailableQty,
              COALESCE(PS.AvailableQty, 0) * Prod.PurchasePrice AS StockValue
         FROM Products.ProductTbl AS Prod
         LEFT JOIN Products.ProductStockTbl AS PS ON PS.ProductUID = Prod.ProductUID
         LEFT JOIN Products.CategoryTbl AS Cat    ON Cat.CategoryUID = Prod.CategoryUID
         LEFT JOIN Global.PrimaryUnitTbl AS Unit  ON Unit.PrimaryUnitUID = Prod.PrimaryUnitUID
        WHERE Prod.OrgUID = ?
          AND Prod.IsDeleted = 0
          AND Prod.IsActive = 1
          AND Prod.ProductType = 'Product'
          AND Prod.IsComposite = 0
        ORDER BY Prod.ItemName ASC
        LIMIT 2000`,
      [orgUID]
    );
  }

  // getBrandWiseSalesData — invoice lines with a brand, per brand, largest first (max 500)
  async brandWiseSales(orgUID: number, from: string, to: string): Promise<Row[]> {
    return this.rows(
      // CI3 selected b.Name, which BrandTbl does not have (the column is BrandName), so this report always failed
      `SELECT Tprod.BrandUID,
              COALESCE(MAX(b.BrandName), 'No Brand') AS BrandName,
              COUNT(DISTINCT Tprod.ProductUID)      AS ProductCount,
              COUNT(DISTINCT Ts.TransUID)           AS InvoiceCount,
              SUM(Tprod.Quantity)                   AS TotalQty,
              SUM(Tprod.Quantity * Tprod.UnitPrice) AS TotalValue,
              AVG(Tprod.UnitPrice)                  AS AvgPrice
         FROM Transaction.TransProductsTbl AS Tprod
         JOIN Transaction.TransactionsTbl  AS Ts
              ON  Ts.TransUID  = Tprod.TransUID
              AND Ts.OrgUID    = Tprod.OrgUID
              AND Ts.ModuleUID = 103
              AND Ts.IsDeleted = 0
              AND Ts.IsActive  = 1
              AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
              AND Ts.TransDate BETWEEN ? AND ?
         LEFT JOIN Products.BrandTbl b ON b.BrandUID = Tprod.BrandUID
        WHERE Tprod.OrgUID = ? AND Tprod.IsDeleted = 0 AND Tprod.IsActive = 1 AND Tprod.BrandUID IS NOT NULL
        GROUP BY Tprod.BrandUID
        ORDER BY TotalValue DESC
        LIMIT 500`,
      [from, to, orgUID]
    );
  }

  // getVariantStockData — every active variant with its stock and value at purchase price (max 2000)
  async variantStock(orgUID: number): Promise<Row[]> {
    return this.rows(
      // CI3 selected / sorted by b.Name, which BrandTbl does not have (BrandName), so this report always failed
      `SELECT pv.VariantUID,
              pv.ProductUID,
              p.ItemName,
              COALESCE(b.BrandName, '—') AS BrandName,
              COALESCE(s.Name, '—') AS SizeName,
              pv.PartNumber,
              pv.PurchasePrice,
              pv.SellingPrice,
              COALESCE(pvs.AvailableQty, 0)                    AS StockQty,
              COALESCE(pvs.AvailableQty, 0) * pv.PurchasePrice AS StockValue
         FROM Products.ProductVariantTbl pv
         JOIN Products.ProductTbl p ON p.ProductUID = pv.ProductUID AND p.OrgUID = pv.OrgUID AND p.IsDeleted = 0
         LEFT JOIN Products.BrandTbl b ON b.BrandUID = pv.BrandUID
         LEFT JOIN Products.SizeTbl  s ON s.SizeUID  = pv.SizeUID
         LEFT JOIN Products.ProductVariantStockTbl pvs ON pvs.VariantUID = pv.VariantUID AND pvs.OrgUID = pv.OrgUID
        WHERE pv.OrgUID = ? AND pv.IsActive = 1
        ORDER BY b.BrandName ASC, s.Name ASC, p.ItemName ASC
        LIMIT 2000`,
      [orgUID]
    );
  }

  // ── Party reports ─────────────────────────────────────────────────────────

  /**
   * getCustomerOutstandingData / getSupplierOutstandingData / getCustomerAgeingData — parties with an open balance on
   * their invoices (103) or purchase bills (105), largest first (max 500). Ageing adds 0-30 … 120+ day buckets.
   */
  async outstanding(orgUID: number, party: "C" | "S", langCode: string, withAgeing = false): Promise<Row[]> {
    const p = party === "C"
      ? { table: "Customers.CustomerTbl", lang: "Customers.CustomersTbl_Lang", key: "CustomerUID", name: "CustomerName", count: "InvoiceCount", module: 103 }
      : { table: "Vendors.VendorTbl", lang: "Vendors.VendorTbl_Lang", key: "VendorUID", name: "VendorName", count: "BillCount", module: 105 };
    const useLang = langCode !== "en";
    const open = "COALESCE(Ts.BalanceAmount, Ts.NetAmount)";
    const bucket = (range: string, alias: string) => `COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), Ts.TransDate) ${range} THEN ${open} ELSE 0 END), 0) AS ${alias}`;
    const amounts = withAgeing
      ? [`COALESCE(SUM(${open}), 0) AS TotalOutstanding`, bucket("BETWEEN 0 AND 30", "Bucket0_30"), bucket("BETWEEN 31 AND 60", "Bucket31_60"),
         bucket("BETWEEN 61 AND 90", "Bucket61_90"), bucket("BETWEEN 91 AND 120", "Bucket91_120"), bucket("> 120", "Bucket120Plus")]
      : ["COALESCE(SUM(Ts.NetAmount), 0) AS TotalBilled", "COALESCE(SUM(COALESCE(Ts.PaidAmount, 0)), 0) AS TotalPaid", `COALESCE(SUM(${open}), 0) AS TotalOutstanding`];
    return this.rows(
      `SELECT Party.${p.key},
              ${useLang ? `COALESCE(MAX(L.Name), Party.Name)` : "Party.Name"} AS ${p.name},
              Party.MobileNumber,
              Party.Area,
              COUNT(DISTINCT Ts.TransUID) AS ${p.count},
              ${amounts.join(",\n              ")}
         FROM ${p.table} Party
         ${useLang ? `LEFT JOIN ${p.lang} L ON L.${p.key} = Party.${p.key} AND L.LangCode = ?` : ""}
         JOIN Transaction.TransactionsTbl Ts
              ON  Ts.PartyUID  = Party.${p.key}
              AND Ts.PartyType = '${party}'
              AND Ts.ModuleUID = ${p.module}
              AND Ts.IsDeleted = 0
              AND Ts.IsActive  = 1
              AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected','Paid')
              AND ${open} > 0.01
        WHERE Party.OrgUID = ? AND Party.IsDeleted = 0 AND Party.IsActive = 1
        GROUP BY Party.${p.key}
       HAVING TotalOutstanding > 0.01
        ORDER BY TotalOutstanding DESC
        LIMIT 500`,
      useLang ? [langCode, orgUID] : [orgUID]
    );
  }

  /**
   * get{Customer,Supplier}LedgerOpening — invoices / bills less returns less payments before the from date.
   * Customer: a positive net is a debit (they owe us). Supplier: a positive net is a credit (we owe them).
   */
  async ledgerOpening(orgUID: number, party: "C" | "S", partyUID: number, before: string): Promise<{ debit: number; credit: number }> {
    const [billModule, returnModule] = party === "C" ? [103, 106] : [105, 108];
    const docs = (module: number) =>
      `SELECT COALESCE(SUM(NetAmount), 0) AS total FROM Transaction.TransactionsTbl
        WHERE OrgUID = ? AND PartyUID = ? AND PartyType = ? AND ModuleUID = ${module}
          AND IsDeleted = 0 AND IsActive = 1 AND DocStatus NOT IN ('Draft','Cancelled','Rejected') AND TransDate < ?`;
    const [bills, returns, payments] = await Promise.all([
      this.rows(docs(billModule), [orgUID, partyUID, party, before]),
      this.rows(docs(returnModule), [orgUID, partyUID, party, before]),
      this.rows(
        `SELECT COALESCE(SUM(Amount), 0) AS total FROM Transaction.PaymentsTbl
          WHERE OrgUID = ? AND PartyUID = ? AND PartyType = ? AND IsDeleted = 0 AND IsActive = 1 AND IsCancelled = 0 AND PaymentDate < ?`,
        [orgUID, partyUID, party, before]
      ),
    ]);
    const total = (rows: Row[]) => Number(rows[0]?.total ?? 0);
    const net = total(bills) - total(returns) - total(payments);
    const round4 = (value: number) => Math.round(value * 10000) / 10000;
    const owedToUs = party === "C" ? net > 0 : net < 0;
    const owedByUs = party === "C" ? net < 0 : net > 0;
    return { debit: owedToUs ? round4(Math.abs(net)) : 0, credit: owedByUs ? round4(Math.abs(net)) : 0 };
  }

  // get{Customer,Supplier}LedgerData — the party's documents and payments in the range, oldest first (max 1000)
  async ledger(orgUID: number, party: "C" | "S", partyUID: number, from: string, to: string): Promise<Row[]> {
    const t = party === "C"
      ? { bill: [103, "Invoice"], ret: [106, "Sales Return"], pay: "Payment Received", billSide: "Debit", otherSide: "Credit" }
      : { bill: [105, "Purchase Bill"], ret: [108, "Purchase Return"], pay: "Payment Made", billSide: "Credit", otherSide: "Debit" };
    // Bills land on one side; returns and payments on the other (customer: Dr / Cr, supplier: Cr / Dr)
    const amounts = (onBillSide: boolean, amount: string) =>
      (onBillSide ? t.billSide : t.otherSide) === "Debit" ? `${amount} AS Debit, 0.00 AS Credit` : `0.00 AS Debit, ${amount} AS Credit`;
    const docs = (module: number, label: string, onBillSide: boolean) =>
      `(SELECT Ts.TransDate AS TxDate, '${label}' AS TxType, Ts.UniqueNumber AS RefNo, ${amounts(onBillSide, "Ts.NetAmount")}
          FROM Transaction.TransactionsTbl Ts
         WHERE Ts.OrgUID = ? AND Ts.PartyUID = ? AND Ts.PartyType = '${party}' AND Ts.ModuleUID = ${module}
           AND Ts.IsDeleted = 0 AND Ts.IsActive = 1 AND Ts.DocStatus NOT IN ('Draft','Cancelled','Rejected')
           AND Ts.TransDate BETWEEN ? AND ?)`;
    return this.rows(
      `${docs(t.bill[0] as number, t.bill[1] as string, true)}
       UNION ALL
       ${docs(t.ret[0] as number, t.ret[1] as string, false)}
       UNION ALL
       (SELECT P.PaymentDate AS TxDate, '${t.pay}' AS TxType, P.UniqueNumber AS RefNo, ${amounts(false, "P.Amount")}
          FROM Transaction.PaymentsTbl P
         WHERE P.OrgUID = ? AND P.PartyUID = ? AND P.PartyType = '${party}'
           AND P.IsDeleted = 0 AND P.IsActive = 1 AND P.IsCancelled = 0
           AND P.PaymentDate BETWEEN ? AND ?)
       ORDER BY TxDate ASC, TxType ASC
       LIMIT 1000`,
      [orgUID, partyUID, from, to, orgUID, partyUID, from, to, orgUID, partyUID, from, to]
    );
  }

  // The document's party: customers ('C') or vendors ('S')
  private static partyJoin(partyType: "C" | "S"): string {
    return partyType === "C"
      ? "LEFT JOIN Customers.CustomerTbl AS Party ON Party.CustomerUID = Ts.PartyUID AND Ts.PartyType = 'C'"
      : "LEFT JOIN Vendors.VendorTbl AS Party ON Party.VendorUID = Ts.PartyUID AND Ts.PartyType = 'S'";
  }

  // getPaymentReceivedData (customers, 'C') / getPaymentMadeData (vendors, 'S') — newest first, at most 1000
  async payments(orgUID: number, partyType: "C" | "S", from: string, to: string): Promise<Row[]> {
    const party =
      partyType === "C"
        ? "LEFT JOIN Customers.CustomerTbl Party ON Party.CustomerUID = P.PartyUID AND P.PartyType = 'C'"
        : "LEFT JOIN Vendors.VendorTbl Party ON Party.VendorUID = P.PartyUID AND P.PartyType = 'S'";
    return this.rows(
      `SELECT P.PaymentUID,
              P.UniqueNumber,
              P.PaymentDate,
              P.Amount,
              P.ReferenceNo,
              P.IsOnAccount,
              P.PartyType,
              COALESCE(Party.Name,     '—')    AS PartyName,
              COALESCE(PT.Name,        'Cash') AS PaymentMode,
              COALESCE(PT.IsCash,      1)      AS IsCash,
              COALESCE(BA.AccountName, 'Cash') AS AccountName
         FROM Transaction.PaymentsTbl P
         ${party}
         LEFT JOIN Global.PaymentTypesTbl          PT ON PT.PaymentTypeUID = P.PaymentTypeUID
         LEFT JOIN Organisation.OrgBankAccountsTbl BA ON BA.BankAccountUID = P.BankAccountUID
        WHERE P.OrgUID = ?
          AND P.PartyType = ?
          AND P.IsDeleted = 0
          AND P.IsActive = 1
          AND P.IsCancelled = 0
          AND P.PaymentDate BETWEEN ? AND ?
        ORDER BY P.PaymentDate DESC, P.PaymentUID DESC
        LIMIT 1000`,
      [orgUID, partyType, from, to]
    );
  }
}
