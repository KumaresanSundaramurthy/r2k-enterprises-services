import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const PAYMENTS = "Transaction.PaymentsTbl";

/*
 * Expense and indirect-income payments keep their record's UID in TransUID, not a TransactionsTbl UID. CI3
 * joined every payment to TransactionsTbl by TransUID, so such a payment showed (and could change) an
 * unrelated invoice; the transaction is joined only for the other payments.
 */
export const LINKED_TO_TRANSACTION = "(P.SourceType IS NULL OR P.SourceType NOT IN ('Expense', 'IndirectIncome'))";

// Payments list filter the CI3 page posts (JSON)
export interface PaymentFilter {
  Status?: string;
  PaymentDirection?: string;
  PartyType?: string;
  ModuleUID?: unknown;
  PaymentSource?: string;
  DateFrom?: string;
  DateTo?: string;
  Search?: string;
  UpdatedByUIDs?: unknown;
  PaymentMode?: unknown;
  DocTypeModuleUIDs?: unknown;
  PartyTypes?: unknown;
  SortBy?: string;
  SortDir?: string;
}

const SORT_COLUMNS: Record<string, string> = {
  Date: "P.CreatedOn",
  Amount: "P.Amount",
  Type: "P.PaymentDirection",
  Party: "PartyName",
};

const intList = (value: unknown): number[] =>
  ([] as unknown[])
    .concat(value ?? [])
    .map((item) => parseInt(String(item), 10))
    .filter((id) => id > 0);
const textList = (value: unknown): string[] => ([] as unknown[]).concat(value ?? []).map(String).filter(Boolean);

/** Payments page reads (CI3 Transactions_model / Organisation_model payment helpers). */
@Injectable()
export class PaymentRecordsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getPaymentsList — live payments, or with Status = Cancelled the cancelled / deleted ones
  async list(orgUID: number, filter: PaymentFilter, limit: number, offset: number): Promise<Row[]> {
    const k = this.read;
    const query = this.base(orgUID, filter)
      .select(
        "P.PaymentUID",
        "P.TransUID",
        "P.PartyUID",
        "P.ModuleUID",
        "P.PartyType",
        "P.PaymentDirection",
        "P.Amount",
        "P.IsFullyPaid",
        "P.ExcessAmount",
        "P.ReferenceNo",
        "P.UniqueNumber as PaymentUniqueNumber",
        "P.Notes",
        "P.CreatedOn",
        "P.ReceiptToken",
        k.raw("CASE WHEN P.PaymentTypeUID = 0 THEN 'Debit Note' ELSE PT.Name END AS PaymentTypeName"),
        "PT.IsCash",
        k.raw("CASE WHEN P.PaymentTypeUID = 0 THEN 'DN' ELSE PT.Code END AS PaymentTypeCode"),
        "T.UniqueNumber as TransNumber",
        "T.TransDate",
        "T.NetAmount as BillAmount",
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.Name ELSE V.Name END AS PartyName"),
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.Area ELSE V.Area END AS PartyArea"),
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.MobileNumber ELSE V.MobileNumber END AS PartyMobile"),
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.CountryCode ELSE V.CountryCode END AS PartyCountryCode"),
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.EmailAddress ELSE V.EmailAddress END AS PartyEmail"),
        "BA.AccountName",
        "BA.BankName",
        "BA.AccountNumber",
        "BA.IFSC",
        "BA.BranchName",
        k.raw("CONCAT(CrUser.FirstName, ' ', CrUser.LastName) AS CreatedByName"),
        "P.IsTransferredToCreditNote",
        "P.IsOnAccount",
        "P.SourceType",
        "P.IsExcessApplied",
        "P.ExcessSourcePaymentUID",
        "P.OnAccountAppliedTransUID",
        "P.OnAccountSourcePaymentUID",
        "AppliedT.UniqueNumber as OnAccountAppliedTransNum",
        "SrcPmt.UniqueNumber as OnAccountSourcePaymentNum"
      )
      .leftJoin("Organisation.OrgBankAccountsTbl as BA", "BA.BankAccountUID", "P.BankAccountUID")
      .leftJoin("Users.UserTbl as CrUser", "CrUser.UserUID", "P.CreatedBy")
      .leftJoin("Transaction.TransactionsTbl as AppliedT", (on) => on.on("AppliedT.TransUID", "P.OnAccountAppliedTransUID").andOnVal("AppliedT.IsDeleted", "=", 0))
      .leftJoin(`${PAYMENTS} as SrcPmt`, (on) => on.on("SrcPmt.PaymentUID", "P.OnAccountSourcePaymentUID").andOnVal("SrcPmt.IsDeleted", "=", 0))
      .orderBy(SORT_COLUMNS[filter.SortBy ?? ""] ?? "P.PaymentUID", String(filter.SortDir ?? "DESC").toUpperCase() === "ASC" ? "asc" : "desc");
    if (limit > 0) query.limit(limit).offset(offset);
    return query;
  }

  async count(orgUID: number, filter: PaymentFilter): Promise<number> {
    const row = await this.base(orgUID, filter).count("* as cnt").first();
    return Number(row?.cnt ?? 0);
  }

  // getPaymentsBalanceStats — cash and bank money in / out
  async balanceStats(orgUID: number, filter: PaymentFilter): Promise<Row> {
    const query = this.read(`${PAYMENTS} as P`)
      .select(
        this.read.raw("SUM(CASE WHEN P.PaymentDirection = 'In'  AND PT.IsCash = 1 THEN P.Amount ELSE 0 END) AS CashIn"),
        this.read.raw("SUM(CASE WHEN P.PaymentDirection = 'Out' AND PT.IsCash = 1 THEN P.Amount ELSE 0 END) AS CashOut"),
        this.read.raw("SUM(CASE WHEN P.PaymentDirection = 'In'  AND PT.IsCash = 0 THEN P.Amount ELSE 0 END) AS BankIn"),
        this.read.raw("SUM(CASE WHEN P.PaymentDirection = 'Out' AND PT.IsCash = 0 THEN P.Amount ELSE 0 END) AS BankOut")
      )
      .leftJoin("Global.PaymentTypesTbl as PT", "PT.PaymentTypeUID", "P.PaymentTypeUID")
      .where({ "P.OrgUID": orgUID, "P.IsDeleted": 0, "P.IsActive": 1, "P.IsCancelled": 0 });
    if (filter.DateFrom) query.whereRaw("DATE(P.CreatedOn) >= ?", [filter.DateFrom]);
    if (filter.DateTo) query.whereRaw("DATE(P.CreatedOn) <= ?", [filter.DateTo]);
    PaymentRecordsRepository.applyColumnFilters(query, filter);
    return (await query.first()) ?? { CashIn: 0, CashOut: 0, BankIn: 0, BankOut: 0 };
  }

  // getPaymentDetailById — the payment with its type, transaction, party, bank and creator
  async detail(orgUID: number, paymentUID: number): Promise<Row | null> {
    const k = this.read;
    const row = await k(`${PAYMENTS} as P`)
      .select(
        "P.PaymentUID",
        "P.TransUID",
        "P.PartyType",
        "P.Amount",
        "P.ExcessAmount",
        "P.IsFullyPaid",
        "P.ReferenceNo",
        "P.Notes",
        "P.CreatedOn",
        "P.PaymentDate",
        "P.UniqueNumber",
        "P.PaymentNumber",
        "P.TransYear",
        "P.ReceiptToken",
        "P.ModuleUID",
        "PT.Name as PaymentTypeName",
        "PT.IsCash",
        "T.UniqueNumber as TransNumber",
        "T.TransDate",
        "T.NetAmount as BillAmount",
        "T.BalanceAmount",
        "T.ModuleUID as TransModuleUID",
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.Name ELSE V.Name END AS PartyName"),
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.Area ELSE V.Area END AS PartyArea"),
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.MobileNumber ELSE V.MobileNumber END AS PartyMobile"),
        k.raw("CASE WHEN P.PartyType = 'C' THEN C.GSTIN ELSE V.GSTIN END AS PartyGSTIN"),
        "BA.AccountName",
        "BA.BankName",
        "BA.AccountNumber",
        "BA.IFSC",
        "BA.BranchName",
        "BA.UPIId",
        "BA.UPINumber",
        k.raw("CONCAT(CrUser.FirstName, ' ', CrUser.LastName) AS CreatedByName")
      )
      .leftJoin("Global.PaymentTypesTbl as PT", "PT.PaymentTypeUID", "P.PaymentTypeUID")
      .leftJoin("Transaction.TransactionsTbl as T", (on) => on.on("T.TransUID", "P.TransUID").andOnVal("T.IsDeleted", "=", 0).andOn(k.raw(LINKED_TO_TRANSACTION)))
      .leftJoin("Customers.CustomerTbl as C", (on) => on.on("C.CustomerUID", "P.PartyUID").andOnVal("P.PartyType", "=", "C"))
      .leftJoin("Vendors.VendorTbl as V", (on) => on.on("V.VendorUID", "P.PartyUID").andOnVal("P.PartyType", "=", "S"))
      .leftJoin("Organisation.OrgBankAccountsTbl as BA", "BA.BankAccountUID", "P.BankAccountUID")
      .leftJoin("Users.UserTbl as CrUser", "CrUser.UserUID", "P.CreatedBy")
      .where({ "P.PaymentUID": paymentUID, "P.OrgUID": orgUID })
      .first();
    return row ?? null;
  }

  // getTransactionPayments — a transaction's live payments, oldest first
  async ofTransaction(orgUID: number, transUID: number): Promise<Row[]> {
    return this.read(`${PAYMENTS} as P`)
      .select(
        "P.PaymentUID",
        "P.PaymentDate",
        "P.Amount",
        "P.ReferenceNo",
        "P.Notes",
        "P.IsFullyPaid",
        "P.ExcessAmount",
        "P.CreatedOn",
        "P.SourceType",
        "PT.Name as PaymentTypeName",
        "PT.IsCash",
        "BA.AccountName",
        "BA.BankName",
        "BA.AccountNumber"
      )
      .leftJoin("Global.PaymentTypesTbl as PT", "PT.PaymentTypeUID", "P.PaymentTypeUID")
      .leftJoin("Organisation.OrgBankAccountsTbl as BA", "BA.BankAccountUID", "P.BankAccountUID")
      .where({ "P.TransUID": transUID, "P.OrgUID": orgUID, "P.IsDeleted": 0, "P.IsActive": 1, "P.IsCancelled": 0 })
      .whereRaw(LINKED_TO_TRANSACTION)
      .orderBy("P.PaymentUID", "asc");
  }

  // getCustomerCreditsDetail — on-account credits and unused advances of a customer
  async customerCredits(orgUID: number, customerUID: number): Promise<Row[]> {
    const [rows] = await this.read.raw(
      `SELECT p.PaymentUID, p.Amount, 'on_account' AS CreditType, t.UniqueNumber AS InvoiceNumber, DATE_FORMAT(p.CreatedOn, '%Y-%m-%d') AS CreatedOn
         FROM Transaction.PaymentsTbl p
         LEFT JOIN Transaction.TransactionsTbl t ON t.TransUID = p.TransUID
        WHERE p.OrgUID = ? AND p.PartyUID = ? AND p.PartyType = 'C' AND p.IsOnAccount = 1 AND p.IsDeleted = 0 AND p.IsCancelled = 0 AND p.Amount > 0
       UNION ALL
       SELECT p.PaymentUID, p.ExcessAmount AS Amount, 'advance' AS CreditType, t.UniqueNumber AS InvoiceNumber, DATE_FORMAT(p.CreatedOn, '%Y-%m-%d') AS CreatedOn
         FROM Transaction.PaymentsTbl p
         LEFT JOIN Transaction.TransactionsTbl t ON t.TransUID = p.TransUID
        WHERE p.OrgUID = ? AND p.PartyUID = ? AND p.PartyType = 'C' AND p.PaymentDirection = 'In' AND p.IsDeleted = 0 AND p.IsCancelled = 0
          AND p.IsExcessApplied = 0 AND p.ExcessAmount > 0
       ORDER BY CreditType, CreatedOn ASC`,
      [orgUID, customerUID, orgUID, customerUID]
    );
    return rows;
  }

  // getCustomerAvailableCredits — the same credits as sources for the payment modal, largest first
  async availableCredits(orgUID: number, customerUID: number): Promise<Row[]> {
    const [rows] = await this.read.raw(
      `SELECT p.PaymentUID, p.TransUID, p.ExcessAmount AS CreditAmount, 'advance' AS CreditType, t.UniqueNumber AS InvoiceNumber
         FROM Transaction.PaymentsTbl p
         LEFT JOIN Transaction.TransactionsTbl t ON t.TransUID = p.TransUID
        WHERE p.OrgUID = ? AND p.PartyUID = ? AND p.PartyType = 'C' AND p.PaymentDirection = 'In' AND p.IsDeleted = 0 AND p.IsCancelled = 0
          AND p.IsExcessApplied = 0 AND p.ExcessAmount > 0
       UNION ALL
       SELECT p.PaymentUID, p.TransUID, p.Amount AS CreditAmount, 'on_account' AS CreditType, t.UniqueNumber AS InvoiceNumber
         FROM Transaction.PaymentsTbl p
         LEFT JOIN Transaction.TransactionsTbl t ON t.TransUID = p.TransUID
        WHERE p.OrgUID = ? AND p.PartyUID = ? AND p.PartyType = 'C' AND p.IsOnAccount = 1 AND p.IsDeleted = 0 AND p.IsCancelled = 0 AND p.Amount > 0
       ORDER BY CreditAmount DESC`,
      [orgUID, customerUID, orgUID, customerUID]
    );
    return rows;
  }

  // getCustomerCreditNoteDetail — a customer's pending credit notes
  async pendingCreditNotes(orgUID: number, customerUID: number): Promise<Row[]> {
    return this.read("Transaction.TransCreditNoteTbl as cn")
      .select("cn.CreditNoteNumber", this.read.raw("DATE_FORMAT(cn.CreatedOn, '%Y-%m-%d') AS CreatedOn"), "cn.Amount")
      .where({ "cn.OrgUID": orgUID, "cn.PartyUID": customerUID, "cn.PartyType": "C", "cn.Status": "Pending", "cn.IsDeleted": 0, "cn.IsCancelled": 0 })
      .orderBy("cn.CreatedOn", "asc");
  }

  // getPaymentTypesList
  async paymentTypes(): Promise<Row[]> {
    return this.read("Global.PaymentTypesTbl").select("PaymentTypeUID", "Name", "Code", "IsCash").where({ IsDeleted: 0, IsActive: 1 }).orderBy("PaymentTypeUID", "asc");
  }

  // getOrgBankAccounts — bank and cash accounts, default first
  async bankAccounts(orgUID: number): Promise<Row[]> {
    return this.read("Organisation.OrgBankAccountsTbl")
      .select("BankAccountUID", "AccountName", "BankName", "AccountNumber", "IFSC", "BranchName", "UPIId", "UPINumber", "IsDefault", "IsCash")
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy([{ column: "IsDefault", order: "desc" }, { column: "AccountName", order: "asc" }]);
  }

  // getBankAccountByUID
  async bankAccount(orgUID: number, bankAccountUID: number): Promise<Row | null> {
    const row = await this.read("Organisation.OrgBankAccountsTbl")
      .select("BankAccountUID", "AccountName", "BankName", "AccountNumber", "IFSC", "BranchName", "UPIId", "UPINumber", "IsDefault")
      .where({ BankAccountUID: bankAccountUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getPrintThemeByType — the organisation's theme for receipts with its template HTML
  async printTheme(orgUID: number, transactionType: string): Promise<Row | null> {
    const row = await this.read("Settings.PrintThemeConfigTbl as TC")
      .select("TC.*", "PT.HtmlContent as TemplateHtmlContent", "PT.PreviewImage as TemplatePreviewImage", "PT.TemplateName as TemplateName")
      .leftJoin("Settings.PrintTemplatesTbl as PT", (on) => on.on("PT.TemplateUID", "TC.TemplateUID").andOnVal("PT.IsDeleted", "=", 0))
      .where({ "TC.OrgUID": orgUID, "TC.TransactionType": transactionType, "TC.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // getThermalPrintConfigByModule
  async thermalConfig(orgUID: number, moduleUID: number): Promise<Row | null> {
    const row = await this.read("Settings.ThermalPrintConfigTbl").where({ OrgUID: orgUID, ModuleUID: moduleUID, IsDeleted: 0 }).first();
    return row ?? null;
  }

  // _getInvoicePaymentSummary — the invoice and what it still owed before this payment
  async invoiceSummary(orgUID: number, transUID: number, paymentUID: number): Promise<{ invoiceNumber: string; invoiceDate: string; outstandingBefore: number } | null> {
    const invoice = await this.read("Transaction.TransactionsTbl").select("NetAmount", "UniqueNumber", "TransDate").where({ TransUID: transUID, OrgUID: orgUID }).first();
    if (!invoice) return null;
    const paid = await this.read(PAYMENTS)
      .sum("Amount as PrevPaid")
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .where("PaymentUID", "<", paymentUID)
      .first();
    return {
      invoiceNumber: String(invoice.UniqueNumber ?? ""),
      invoiceDate: String(invoice.TransDate ?? ""),
      outstandingBefore: Math.max(0, Number(invoice.NetAmount ?? 0) - Number(paid?.PrevPaid ?? 0)),
    };
  }

  // GenSettings: PrintDateFormat, CurrenySymbol, ShowStats; TransSettings: ShowTransactionStats
  async printSettings(orgUID: number): Promise<{ printDateFormat: string; currency: string; showStats: boolean }> {
    const [general, transaction] = await Promise.all([
      this.read("Settings.OrgSettingsTbl").select("PrintDateFormat", "CurrenySymbol", "ShowStats").where({ OrgUID: orgUID }).first(),
      this.read("Settings.TransactionSettingsTbl").select("ShowTransactionStats").where({ OrgUID: orgUID }).first(),
    ]);
    return {
      printDateFormat: general?.PrintDateFormat || "d M Y",
      currency: general?.CurrenySymbol || "₹",
      showStats: Number(general?.ShowStats ?? 1) === 1 && Number(transaction?.ShowTransactionStats ?? 1) === 1,
    };
  }

  // Login users for the "recorded by" filter (CI3 getOrgUsersForCache)
  async orgUsers(orgUID: number): Promise<Row[]> {
    return this.read("Users.UserTbl")
      .select("UserUID", "FirstName", "LastName", this.read.raw("CONCAT(FirstName, ' ', LastName) AS FullName"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1, HasLoginAccess: 1 })
      .orderBy("FirstName", "asc");
  }

  // Userpreferences_model::getUserPreference
  async preference(orgUID: number, branchUID: number, userUID: number, key: string): Promise<string | null> {
    const row = await this.read("Users.UserPreferencesTbl").select("PreferenceValue").where({ OrgUID: orgUID, BranchUID: branchUID, UserUID: userUID, PreferenceKey: key }).first();
    return row?.PreferenceValue ?? null;
  }

  // Payments with their type, transaction and party joined, the list filters applied
  private base(orgUID: number, filter: PaymentFilter): Knex.QueryBuilder {
    const k = this.read;
    const query = k(`${PAYMENTS} as P`)
      .leftJoin("Global.PaymentTypesTbl as PT", "PT.PaymentTypeUID", "P.PaymentTypeUID")
      .leftJoin("Transaction.TransactionsTbl as T", (on) => on.on("T.TransUID", "P.TransUID").andOnVal("T.IsDeleted", "=", 0).andOn(k.raw(LINKED_TO_TRANSACTION)))
      .leftJoin("Customers.CustomerTbl as C", (on) => on.on("C.CustomerUID", "P.PartyUID").andOnVal("P.PartyType", "=", "C"))
      .leftJoin("Vendors.VendorTbl as V", (on) => on.on("V.VendorUID", "P.PartyUID").andOnVal("P.PartyType", "=", "S"))
      .where("P.OrgUID", orgUID);
    if (filter.Status === "Cancelled") query.where((w) => w.where("P.IsCancelled", 1).orWhere("P.IsDeleted", 1));
    else query.where({ "P.IsDeleted": 0, "P.IsActive": 1, "P.IsCancelled": 0 });
    if (filter.PaymentDirection) query.where("P.PaymentDirection", filter.PaymentDirection);
    if (filter.PartyType) query.where("P.PartyType", filter.PartyType);
    if (Number(filter.ModuleUID) > 0) query.where("P.PaymentModuleUID", parseInt(String(filter.ModuleUID), 10));
    if (filter.PaymentSource) query.where("P.PaymentSource", filter.PaymentSource);
    if (filter.DateFrom) query.whereRaw("DATE(P.CreatedOn) >= ?", [filter.DateFrom]);
    if (filter.DateTo) query.whereRaw("DATE(P.CreatedOn) <= ?", [filter.DateTo]);
    if (filter.Search) this.whereAnyLike(query, ["T.UniqueNumber", "C.Name", "V.Name"], String(filter.Search));
    PaymentRecordsRepository.applyColumnFilters(query, filter);
    return query;
  }

  // Recorded-by, payment-mode, document-type and party-type column filters (list, count and stats)
  private static applyColumnFilters(query: Knex.QueryBuilder, filter: PaymentFilter): void {
    const users = intList(filter.UpdatedByUIDs);
    if (users.length > 0) query.whereIn("P.CreatedBy", users);
    const modes = textList(filter.PaymentMode);
    if (modes.length > 0) query.whereIn("PT.Name", modes);
    const docTypes = intList(filter.DocTypeModuleUIDs);
    if (docTypes.length > 0) query.whereIn("P.ModuleUID", docTypes);
    const partyTypes = textList(filter.PartyTypes).filter((type) => type === "C" || type === "S");
    if (partyTypes.length > 0) query.whereIn("P.PartyType", partyTypes);
  }
}
