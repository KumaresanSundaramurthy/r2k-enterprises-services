import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { resolveCdnUrl, todayDate } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const TRANSACTIONS = "Transaction.TransactionsTbl";

/*
 * Payments of this transaction. Expense / indirect-income payments keep their own record's UID in TransUID,
 * so they are left out (CI3 summed them in when the numbers collided).
 */
const OWN_PAYMENT = "(P.SourceType IS NULL OR P.SourceType NOT IN ('Expense', 'IndirectIncome'))";
const PAID_BY = (alias: string) =>
  `COALESCE((SELECT SUM(P.Amount) FROM Transaction.PaymentsTbl P WHERE P.TransUID = ${alias}.TransUID AND P.IsDeleted = 0 AND P.IsActive = 1 AND P.IsCancelled = 0 AND ${OWN_PAYMENT}), 0)`;

// List filter the CI3 pages post (JSON): status tab, date range, search and the filter bar
export interface TransFilter {
  Status?: string;
  Name?: string;
  DateFrom?: string;
  DateTo?: string;
  StatusList?: unknown;
  MinAmount?: unknown;
  MaxAmount?: unknown;
  PaymentStatus?: string;
  PaymentMode?: string;
  PartyUID?: unknown;
  UpdatedBy?: unknown;
  UpdatedByUIDs?: unknown;
  SortBy?: string;
  SortDir?: string;
  BranchUID?: number;
}

const SORT_COLUMNS: Record<string, string> = { Date: "Ts.TransDate", Amount: "Ts.NetAmount", Number: "Ts.TransNumber" };
const LIST_STATUSES = ["Pending", "Accepted", "Converted", "Draft", "Cancelled", "Rejected"];
const intList = (value: unknown): number[] =>
  ([] as unknown[])
    .concat(value ?? [])
    .map((item) => parseInt(String(item), 10))
    .filter((id) => !Number.isNaN(id));

/** Transaction documents (CI3 Transactions_model): list, stats, one document, its lines, charges and files. */
@Injectable()
export class TransactionsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getTransactionPageList — one page of a module's documents with party, payment and link summaries
  async list(orgUID: number, moduleUID: number, filter: TransFilter, limit: number, offset: number, langCode: string): Promise<Row[]> {
    const k = this.read;
    const useLang = BaseRepository.useLang(langCode);
    const query = this.base(orgUID, moduleUID, filter)
      .select(
        "Ts.TransUID",
        "Ts.TransToken",
        "Ts.ModuleUID",
        "Ts.PartyUID",
        "Ts.UniqueNumber",
        "Ts.TransNumber",
        "Ts.TransDate",
        "Ts.DocStatus as Status",
        "Ts.NetAmount",
        k.raw(useLang ? "COALESCE(CL.Name, Cust.Name, VL.Name, Vend.Name) AS PartyName" : "COALESCE(Cust.Name, Vend.Name) AS PartyName"),
        k.raw(useLang ? "COALESCE(CL.Area, Cust.Area, VL.Area, Vend.Area) AS PartyArea" : "COALESCE(Cust.Area, Vend.Area) AS PartyArea"),
        k.raw("COALESCE(Cust.MobileNumber, Vend.MobileNumber) AS MobileNumber"),
        k.raw("COALESCE(Cust.CountryCode, Vend.CountryCode) AS CountryCode"),
        k.raw("COALESCE(Cust.EmailAddress, Vend.EmailAddress) AS EmailAddress"),
        k.raw("COALESCE(Cust.Image, Vend.Image) AS PartyImage"),
        "Td.ValidityDate",
        "Td.ExpectedDeliveryDate",
        "Td.DeliveryByDate",
        "Ts.UpdatedOn",
        k.raw("CONCAT(User.FirstName, ' ', User.LastName) AS UpdatedBy"),
        k.raw("IFNULL(PaidSum.PaidAmount, 0) AS PaidAmount"),
        k.raw("CONCAT(CreatedUser.FirstName, ' ', CreatedUser.LastName) AS CreatedBy"),
        k.raw("IFNULL(PayInfo.PaymentCount, 0) AS PaymentCount"),
        "PayInfo.PaymentModes",
        "PayInfo.PayBankName",
        "PayInfo.PayAccountNumber",
        k.raw("IFNULL(PayInfo.PaymentAttachmentCount, 0) AS PaymentAttachmentCount"),
        k.raw("(SELECT COUNT(*) FROM Transaction.TransAttachmentsTbl AT WHERE AT.TransUID = Ts.TransUID AND AT.IsDeleted = 0 AND AT.IsActive = 1) AS AttachmentCount"),
        "Ts.PdfPath",
        "Ts.DocType",
        k.raw(
          "(SELECT COUNT(*) FROM Transaction.PaymentsTbl adv WHERE adv.TransUID = Ts.TransUID AND adv.IsExcessApplied = 1 AND adv.IsDeleted = 0 AND adv.IsCancelled = 0) AS HasAdvanceIn"
        ),
        k.raw(
          "(SELECT COUNT(*) FROM Transaction.PaymentsTbl src INNER JOIN Transaction.PaymentsTbl memo ON memo.ExcessSourcePaymentUID = src.PaymentUID WHERE src.TransUID = Ts.TransUID AND src.IsDeleted = 0 AND src.IsCancelled = 0 AND memo.IsDeleted = 0 AND memo.IsCancelled = 0) AS HasAdvanceOut"
        ),
        k.raw(
          "(SELECT COUNT(*) FROM Transaction.PaymentsTbl oa WHERE oa.TransUID = Ts.TransUID AND oa.OnAccountSourcePaymentUID > 0 AND oa.IsDeleted = 0 AND oa.IsCancelled = 0) AS HasOnAccountIn"
        ),
        k.raw(
          "(SELECT COUNT(*) FROM Transaction.PaymentsTbl cnp WHERE cnp.TransUID = Ts.TransUID AND cnp.SourceType = 'CreditNote' AND cnp.IsDeleted = 0 AND cnp.IsCancelled = 0) AS HasCreditNoteIn"
        ),
        k.raw(
          `(SELECT COUNT(*) FROM Transaction.TransProductsTbl RP INNER JOIN Transaction.TransactionsTbl RTP ON RTP.TransUID = RP.TransUID
             WHERE RP.SourceTransProdUID IN (SELECT TransProdUID FROM Transaction.TransProductsTbl WHERE TransUID = Ts.TransUID AND IsDeleted = 0 AND IsActive = 1)
               AND RTP.ModuleUID = 106 AND RTP.OrgUID = Ts.OrgUID AND RTP.IsDeleted = 0 AND RTP.IsCancelled = 0 AND RP.IsDeleted = 0 AND RP.IsActive = 1) AS HasSalesReturn`
        )
      )
      .leftJoin("Transaction.TransDetailTbl as Td", (on) => on.on("Td.TransUID", "Ts.TransUID").andOn(k.raw("Td.FinancialYear = YEAR(Ts.TransDate)")))
      .leftJoin("Users.UserTbl as User", "User.UserUID", "Ts.UpdatedBy")
      .leftJoin("Users.UserTbl as CreatedUser", "CreatedUser.UserUID", "Ts.CreatedBy")
      .leftJoin(
        k.raw(
          `(SELECT P.TransUID, SUM(P.Amount) AS PaidAmount FROM Transaction.PaymentsTbl P
             WHERE P.OrgUID = ? AND P.IsDeleted = 0 AND P.IsActive = 1 AND P.IsCancelled = 0 AND ${OWN_PAYMENT} GROUP BY P.TransUID) AS PaidSum`,
          [orgUID]
        ),
        "PaidSum.TransUID",
        "Ts.TransUID"
      )
      .leftJoin(
        k.raw(
          `(SELECT P.TransUID, COUNT(*) AS PaymentCount,
                   GROUP_CONCAT(CASE WHEN P.SourceType = 'CreditNote' THEN 'Credit Note' WHEN P.PaymentTypeUID = 0 THEN 'Debit Note' ELSE PT.Name END ORDER BY P.PaymentUID ASC SEPARATOR ',') AS PaymentModes,
                   MAX(CASE WHEN P.SourceType != 'CreditNote' AND PT.IsCash = 0 THEN BA.BankName ELSE NULL END) AS PayBankName,
                   MAX(CASE WHEN P.SourceType != 'CreditNote' AND PT.IsCash = 0 THEN BA.AccountNumber ELSE NULL END) AS PayAccountNumber,
                   (SELECT COUNT(*) FROM Transaction.PaymentAttachmentsTbl PA
                     WHERE PA.PaymentUID IN (SELECT PaymentUID FROM Transaction.PaymentsTbl P2 WHERE P2.TransUID = P.TransUID AND P2.IsDeleted = 0 AND P2.IsActive = 1 AND P2.IsCancelled = 0)
                       AND PA.IsDeleted = 0 AND PA.IsActive = 1) AS PaymentAttachmentCount
              FROM Transaction.PaymentsTbl P
              LEFT JOIN Global.PaymentTypesTbl PT ON PT.PaymentTypeUID = P.PaymentTypeUID
              LEFT JOIN Organisation.OrgBankAccountsTbl BA ON BA.BankAccountUID = P.BankAccountUID
             WHERE P.OrgUID = ? AND P.IsDeleted = 0 AND P.IsActive = 1 AND P.IsCancelled = 0 AND ${OWN_PAYMENT}
             GROUP BY P.TransUID) AS PayInfo`,
          [orgUID]
        ),
        "PayInfo.TransUID",
        "Ts.TransUID"
      )
      .orderBy(SORT_COLUMNS[filter.SortBy ?? ""] ?? "Ts.TransUID", String(filter.SortDir ?? "DESC").toUpperCase() === "ASC" ? "asc" : "desc");
    if (useLang) {
      query
        .leftJoin("Customers.CustomersTbl_Lang as CL", (on) => on.on("CL.CustomerUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "C").andOnVal("CL.LangCode", "=", langCode))
        .leftJoin("Vendors.VendorTbl_Lang as VL", (on) => on.on("VL.VendorUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "S").andOnVal("VL.LangCode", "=", langCode));
    }
    if (limit > 0) query.limit(limit).offset(offset);
    return query;
  }

  async count(orgUID: number, moduleUID: number, filter: TransFilter): Promise<number> {
    const row = await this.base(orgUID, moduleUID, filter).count("* as cnt").first();
    return Number(row?.cnt ?? 0);
  }

  // getTransactionUIDsByFilter — every document matching the list filter ("select all" bulk delete)
  async uidsByFilter(orgUID: number, moduleUID: number, filter: TransFilter): Promise<number[]> {
    const rows: Row[] = await this.base(orgUID, moduleUID, filter).select("Ts.TransUID");
    return rows.map((row) => Number(row.TransUID));
  }

  /**
   * getTransactionSummaryStats — count and total per status (Paid / Partial worked out from the payments, as
   * the list badges do) plus the Pending documents past their validity date (Expired).
   */
  async summaryStats(orgUID: number, moduleUID: number, filter: TransFilter): Promise<Record<string, { count: number; amount: number }>> {
    // Bound in order: the payments subquery's org, then the document filters
    const params: (string | number)[] = [orgUID, moduleUID, orgUID];
    let where = "";
    if (filter.DateFrom && filter.DateTo) {
      where += " AND Ts.TransDate >= ? AND Ts.TransDate <= ?";
      params.push(filter.DateFrom, filter.DateTo);
    }
    if (Number(filter.BranchUID) > 0) {
      where += " AND Ts.BranchUID = ?";
      params.push(Number(filter.BranchUID));
    }
    const [rows] = await this.read.raw(
      `SELECT CASE
                WHEN Ts.DocStatus IN ('Draft', 'Cancelled', 'Rejected') THEN Ts.DocStatus
                WHEN IFNULL(PaidSum.PaidAmount, 0) >= Ts.NetAmount AND Ts.NetAmount > 0 THEN 'Paid'
                WHEN IFNULL(PaidSum.PaidAmount, 0) > 0 THEN 'Partial'
                ELSE Ts.DocStatus
              END AS ComputedStatus,
              COUNT(*) AS TotalCount, SUM(Ts.NetAmount) AS TotalAmount
         FROM Transaction.TransactionsTbl AS Ts
         LEFT JOIN (SELECT P.TransUID, SUM(P.Amount) AS PaidAmount FROM Transaction.PaymentsTbl P
                     WHERE P.OrgUID = ? AND P.IsDeleted = 0 AND P.IsActive = 1 AND P.IsCancelled = 0 AND ${OWN_PAYMENT} GROUP BY P.TransUID) AS PaidSum
                ON PaidSum.TransUID = Ts.TransUID
        WHERE Ts.ModuleUID = ? AND Ts.OrgUID = ? AND Ts.IsDeleted = 0 ${where}
        GROUP BY ComputedStatus`,
      params
    );
    const stats: Record<string, { count: number; amount: number }> = {};
    for (const row of rows as Row[]) stats[String(row.ComputedStatus)] = { count: Number(row.TotalCount), amount: Number(row.TotalAmount ?? 0) };

    const expired = await this.read(`${TRANSACTIONS} as Ts`)
      .count("* as ExpiredCount")
      .sum("Ts.NetAmount as ExpiredAmount")
      .leftJoin("Transaction.TransDetailTbl as Td", (on) => on.on("Td.TransUID", "Ts.TransUID").andOn(this.read.raw("Td.FinancialYear = YEAR(Ts.TransDate)")))
      .where({ "Ts.ModuleUID": moduleUID, "Ts.OrgUID": orgUID, "Ts.IsDeleted": 0, "Ts.DocStatus": "Pending" })
      .where("Td.ValidityDate", "<", todayDate())
      .whereNotNull("Td.ValidityDate")
      .first();
    stats.Expired = { count: Number(expired?.ExpiredCount ?? 0), amount: Number(expired?.ExpiredAmount ?? 0) };
    return stats;
  }

  // getTransactionById — the document with its party, addresses and detail fields (moduleUID null: any module)
  async find(orgUID: number, transUID: number, moduleUID: number | null, langCode = "en", trx?: Knex.Transaction): Promise<Row | null> {
    const k = trx ?? this.read;
    const useLang = BaseRepository.useLang(langCode);
    const pick = (translated: string, base: string, alias: string) => k.raw(useLang ? `COALESCE(${translated}, ${base}) AS ${alias}` : `${base} AS ${alias}`);
    const query = k(`${TRANSACTIONS} as Ts`)
      .select(
        "Ts.*",
        k.raw(useLang ? "COALESCE(CustL.Name, Cust.Name, VendL.Name, Vend.Name) AS PartyName" : "COALESCE(Cust.Name, Vend.Name) AS PartyName"),
        k.raw(useLang ? "COALESCE(CustL.Area, Cust.Area, VendL.Area, Vend.Area) AS PartyArea" : "COALESCE(Cust.Area, Vend.Area) AS PartyArea"),
        k.raw("COALESCE(Cust.CountryCode, Vend.CountryCode) AS PartyCountryCode"),
        k.raw("COALESCE(Cust.MobileNumber, Vend.MobileNumber) AS PartyMobile"),
        k.raw("COALESCE(Cust.EmailAddress, Vend.EmailAddress) AS PartyEmail"),
        k.raw("COALESCE(Cust.GSTIN, Vend.GSTIN) AS PartyGSTIN"),
        pick("BillAddrL.Line1", "BillAddr.Line1", "BillLine1"),
        pick("BillAddrL.Line2", "BillAddr.Line2", "BillLine2"),
        pick("BillAddrL.CityText", "BillAddr.CityText", "BillCity"),
        pick("BillAddrL.StateText", "BillAddr.StateText", "BillState"),
        "BillAddr.Pincode as BillPincode",
        pick("ShipAddrL.Line1", "ShipAddr.Line1", "ShipLine1"),
        pick("ShipAddrL.Line2", "ShipAddr.Line2", "ShipLine2"),
        pick("ShipAddrL.CityText", "ShipAddr.CityText", "ShipCity"),
        pick("ShipAddrL.StateText", "ShipAddr.StateText", "ShipState"),
        "ShipAddr.Pincode as ShipPincode",
        "Td.ValidityDays",
        "Td.ValidityDate",
        "Td.Reference",
        "Td.SupplierInvoiceNo",
        "Td.Notes",
        "Td.TermsConditions",
        "Td.PlaceOfSupplyCode",
        "Td.PlaceOfSupplyName",
        "Td.SignatureUID",
        "Td.ExpectedDeliveryDate",
        "Td.DeliveryByDate",
        "Td.PriceListUID",
        "Td.PriceListData"
      )
      .leftJoin("Customers.CustomerTbl as Cust", (on) => on.on("Cust.CustomerUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "C"))
      .leftJoin("Vendors.VendorTbl as Vend", (on) => on.on("Vend.VendorUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "S"))
      .leftJoin("Transaction.TransDetailTbl as Td", (on) => on.on("Td.TransUID", "Ts.TransUID").andOn(k.raw("Td.FinancialYear = YEAR(Ts.TransDate)")))
      .leftJoin("Customers.CustAddressTbl as BillAddr", (on) =>
        on.on("BillAddr.CustomerUID", "Ts.PartyUID").andOnVal("BillAddr.AddressType", "=", "Billing").andOnVal("BillAddr.IsDeleted", "=", 0).andOnVal("BillAddr.IsActive", "=", 1)
      )
      .leftJoin("Customers.CustAddressTbl as ShipAddr", (on) =>
        on.on("ShipAddr.CustomerUID", "Ts.PartyUID").andOnVal("ShipAddr.AddressType", "=", "Shipping").andOnVal("ShipAddr.IsDeleted", "=", 0).andOnVal("ShipAddr.IsActive", "=", 1)
      )
      .where({ "Ts.TransUID": transUID, "Ts.OrgUID": orgUID, "Ts.IsDeleted": 0 });
    if (moduleUID !== null) query.where("Ts.ModuleUID", moduleUID);
    if (useLang) {
      query
        .leftJoin("Customers.CustomersTbl_Lang as CustL", (on) => on.on("CustL.CustomerUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "C").andOnVal("CustL.LangCode", "=", langCode))
        .leftJoin("Vendors.VendorTbl_Lang as VendL", (on) => on.on("VendL.VendorUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "S").andOnVal("VendL.LangCode", "=", langCode))
        .leftJoin("Customers.CustAddressTbl_Lang as BillAddrL", (on) => on.on("BillAddrL.CustAddressUID", "BillAddr.CustAddressUID").andOnVal("BillAddrL.LangCode", "=", langCode))
        .leftJoin("Customers.CustAddressTbl_Lang as ShipAddrL", (on) => on.on("ShipAddrL.CustAddressUID", "ShipAddr.CustAddressUID").andOnVal("ShipAddrL.LangCode", "=", langCode));
    }
    return (await query.first()) ?? null;
  }

  // getTransactionByToken — the document of the module holding the edit-link token
  async uidByToken(orgUID: number, moduleUID: number, token: string): Promise<number> {
    const row = await this.read(TRANSACTIONS).select("TransUID").where({ TransToken: token, OrgUID: orgUID, ModuleUID: moduleUID, IsDeleted: 0 }).first();
    return row ? Number(row.TransUID) : 0;
  }

  // getReturnedQtyMapForItems — quantity already returned per source line (a return being edited left out)
  async returnedQuantities(orgUID: number, transProdUIDs: number[], excludeTransUID = 0): Promise<Map<number, number>> {
    if (transProdUIDs.length === 0) return new Map();
    const query = this.read("Transaction.TransProductsTbl")
      .select("SourceTransProdUID")
      .sum("Quantity as ReturnedQty")
      .whereIn("SourceTransProdUID", transProdUIDs)
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .groupBy("SourceTransProdUID");
    if (excludeTransUID > 0) query.whereNot("TransUID", excludeTransUID);
    const rows: Row[] = await query;
    return new Map(rows.map((row) => [Number(row.SourceTransProdUID), Number(row.ReturnedQty ?? 0)]));
  }

  // getTransactionItems — live lines in order, with HSN, catalogue price and variant part number
  async items(orgUID: number, transUID: number, trx?: Knex.Transaction): Promise<Row[]> {
    const k = trx ?? this.read;
    return k("Transaction.TransProductsTbl as Tprod")
      .select(
        "Tprod.*",
        "Product.HSNSACCode as HSNCode",
        "Product.SellingPrice as CatalogSellingPrice",
        "Product.IsBrandApplicable as IsBrandApplicable",
        "Product.PartNumber as ProductPartNumber",
        k.raw("COALESCE(Variant.PartNumber, '') AS VariantPartNumber")
      )
      .leftJoin("Products.ProductTbl as Product", "Product.ProductUID", "Tprod.ProductUID")
      .leftJoin("Products.ProductVariantTbl as Variant", "Variant.VariantUID", "Tprod.VariantUID")
      .where({ "Tprod.TransUID": transUID, "Tprod.OrgUID": orgUID, "Tprod.IsDeleted": 0 })
      .orderBy("Tprod.ItemSequence", "asc");
  }

  // getTransactionCharges
  async charges(orgUID: number, transUID: number): Promise<Row[]> {
    return this.read("Transaction.TransactionChargesTbl as TC")
      .select("TC.TransChargeUID", "TC.ChargeUID", "TC.ChargeName", "TC.ChargeDisplayName", "TC.InPercent", "TC.WithoutTaxAmount", "TC.TaxUID", "TC.TaxPercent", "TC.TaxAmount", "TC.WithTaxAmount", "TC.SortOrder")
      .where({ "TC.TransactionUID": transUID, "TC.OrgUID": orgUID, "TC.IsActive": 1, "TC.IsDeleted": 0 })
      .orderBy([{ column: "TC.SortOrder" }, { column: "TC.TransChargeUID" }]);
  }

  // getTransactionAttachments — with each file's CDN URL
  async attachments(orgUID: number, transUID: number): Promise<Row[]> {
    const rows: Row[] = await this.read("Transaction.TransAttachmentsTbl")
      .select("AttachUID", "FileName", "FilePath", "FileType", "FileSize", "CreatedOn")
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy([{ column: "SortOrder" }, { column: "AttachUID" }]);
    return rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath as string) }));
  }

  // getTransactionPayments — the document's live payments, oldest first
  async payments(orgUID: number, transUID: number): Promise<Row[]> {
    return this.read("Transaction.PaymentsTbl as P")
      .select(
        "P.PaymentUID",
        "P.UniqueNumber",
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
      .whereRaw(OWN_PAYMENT)
      .orderBy("P.PaymentUID", "asc");
  }

  // getTransactionsPrefixDetails — the organisation's live prefixes (of one module when given), default first
  async prefixes(orgUID: number, moduleUID?: number, prefixUID?: number, trx?: Knex.Transaction): Promise<Row[]> {
    const query = (trx ?? this.read)("Settings.TransactionPrefixTbl as Prefix")
      .select(
        "Prefix.PrefixUID",
        "Prefix.OrgUID",
        "Prefix.ModuleUID",
        "Prefix.Name",
        "Prefix.IncludeFiscalYear",
        "Prefix.FiscalYearFormat",
        "Prefix.IncludeShortName",
        "Prefix.ShortName",
        "Prefix.Separator",
        "Prefix.NumberPadding",
        "Prefix.IsDefault",
        "Prefix.ComponentConfig"
      )
      .where({ "Prefix.OrgUID": orgUID, "Prefix.IsDeleted": 0, "Prefix.IsActive": 1 })
      .orderBy([{ column: "Prefix.IsDefault", order: "desc" }, { column: "Prefix.PrefixUID", order: "asc" }]);
    if (moduleUID) query.where("Prefix.ModuleUID", moduleUID);
    if (prefixUID) query.where("Prefix.PrefixUID", prefixUID);
    return query;
  }

  // getNextTransactionNumber — one above the module's highest number on the prefix (-1 past the INT limit)
  async nextNumber(orgUID: number, moduleUID: number, prefixUID: number, trx?: Knex.Transaction): Promise<number> {
    const row = await (trx ?? this.read)(TRANSACTIONS).max("TransNumber as MaxNumber").where({ OrgUID: orgUID, ModuleUID: moduleUID, PrefixUID: prefixUID }).first();
    const next = Number(row?.MaxNumber ?? 0) + 1;
    return next > 2147483647 ? -1 : next;
  }

  // getTransactionByPrefixAndNumber / checkTransactionNumberExists — a live document already holds the number
  async numberTaken(trx: Knex.Transaction, orgUID: number, prefixUID: number, transNumber: number): Promise<boolean> {
    return !!(await trx(TRANSACTIONS).select("TransUID").where({ PrefixUID: prefixUID, TransNumber: transNumber, OrgUID: orgUID, IsDeleted: 0 }).first());
  }

  // getNextAvailableTransNumber — above the prefix's highest, skipping numbers a live document holds
  async nextAvailableNumber(trx: Knex.Transaction, orgUID: number, prefixUID: number): Promise<number> {
    const row = await trx(TRANSACTIONS).max("TransNumber as MaxNumber").where({ PrefixUID: prefixUID, OrgUID: orgUID }).first();
    let next = Number(row?.MaxNumber ?? 0) + 1;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (next > 2147483647) return -1;
      if (!(await this.numberTaken(trx, orgUID, prefixUID, next))) break;
      next++;
    }
    return next > 2147483647 ? -1 : next;
  }

  // hasNewerTransactions — a live document of the module was created after this one
  async hasNewer(trx: Knex.Transaction, orgUID: number, moduleUID: number, transUID: number): Promise<boolean> {
    return !!(await trx(TRANSACTIONS).select("TransUID").where({ OrgUID: orgUID, ModuleUID: moduleUID, IsDeleted: 0 }).where("TransUID", ">", transUID).first());
  }

  // getCustomerCountryCode — "IN" for India; null when unknown
  async customerCountry(orgUID: number, customerUID: number, trx?: Knex.Transaction): Promise<string | null> {
    if (customerUID <= 0) return null;
    const row = await (trx ?? this.read)("Customers.CustomerTbl").select("CountryISO2").where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 }).first();
    return row?.CountryISO2 || null;
  }

  // The organisation's live documents of a module with the list filters applied (applyFilters)
  private base(orgUID: number, moduleUID: number, filter: TransFilter): Knex.QueryBuilder {
    const k = this.read;
    const query = k(`${TRANSACTIONS} as Ts`)
      .leftJoin("Customers.CustomerTbl as Cust", (on) => on.on("Cust.CustomerUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "C"))
      .leftJoin("Vendors.VendorTbl as Vend", (on) => on.on("Vend.VendorUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "S"))
      // CI3 left the organisation out when the filter did not carry it, so refreshed lists showed every organisation's documents
      .where({ "Ts.OrgUID": orgUID, "Ts.IsDeleted": 0, "Ts.IsActive": 1, "Ts.ModuleUID": moduleUID });

    if (Number(filter.BranchUID) > 0) query.where("Ts.BranchUID", Number(filter.BranchUID));
    if (filter.Name) this.whereAnyLike(query, ["Cust.Name", "Cust.MobileNumber", "Ts.TransNumber", "Ts.UniqueNumber"], String(filter.Name));
    if (filter.DateFrom && filter.DateTo) query.where("Ts.TransDate", ">=", filter.DateFrom).where("Ts.TransDate", "<=", filter.DateTo);

    switch (filter.Status ?? "All") {
      case "InvPending":
        query.whereIn("Ts.DocStatus", ["Issued", "Partial"]).whereRaw(`(Ts.NetAmount - ${PAID_BY("Ts")}) > 0.01`);
        break;
      case "SRPending":
      case "PRPending":
        query.whereIn("Ts.DocStatus", ["Approved", "Partial"]);
        break;
      case "Pending":
        query.whereIn("Ts.DocStatus", ["Received", "Partial"]);
        break;
      case "Received":
      case "Partial":
      case "Accepted":
      case "Converted":
      case "Draft":
        query.where("Ts.DocStatus", filter.Status);
        break;
      case "Open":
        query.where("Ts.DocStatus", "Pending");
        break;
      case "Paid":
        query.whereNotIn("Ts.DocStatus", ["Draft", "Cancelled", "Rejected"]).where("Ts.NetAmount", ">", 0).whereRaw(`${PAID_BY("Ts")} >= Ts.NetAmount`);
        break;
      case "Cancelled":
        query.whereIn("Ts.DocStatus", ["Cancelled", "Rejected"]);
        break;
      default:
        query.whereNotIn("Ts.DocStatus", ["Draft", "Cancelled", "Rejected"]);
    }

    const statuses = ([] as unknown[]).concat(Array.isArray(filter.StatusList) ? filter.StatusList : []).filter((s): s is string => LIST_STATUSES.includes(String(s)));
    if (statuses.length > 0) query.whereIn("Ts.DocStatus", statuses);
    if (Number(filter.MinAmount)) query.where("Ts.NetAmount", ">=", Number(filter.MinAmount));
    if (Number(filter.MaxAmount)) query.where("Ts.NetAmount", "<=", Number(filter.MaxAmount));
    if (filter.PaymentStatus === "Paid") query.where("Ts.DocStatus", "Paid");
    else if (filter.PaymentStatus === "Partially Paid") query.where("Ts.DocStatus", "Partial");
    else if (filter.PaymentStatus === "Pending") query.whereNotIn("Ts.DocStatus", ["Paid", "Partial", "Draft", "Cancelled", "Rejected"]);
    if (filter.PaymentMode) {
      query.whereExists((sub) =>
        sub
          .select(k.raw("1"))
          .from("Transaction.PaymentsTbl as _P")
          .join("Global.PaymentTypesTbl as _PT", "_PT.PaymentTypeUID", "_P.PaymentTypeUID")
          .whereRaw("_P.TransUID = Ts.TransUID")
          .where({ "_PT.Name": filter.PaymentMode, "_P.IsDeleted": 0, "_P.IsActive": 1, "_P.IsCancelled": 0 })
      );
    }
    if (Number(filter.PartyUID) > 0) query.where("Ts.PartyUID", parseInt(String(filter.PartyUID), 10));
    if (Number(filter.UpdatedBy) > 0) query.where("Ts.UpdatedBy", parseInt(String(filter.UpdatedBy), 10));
    const updatedBy = intList(filter.UpdatedByUIDs);
    if (updatedBy.length > 0) query.whereIn("Ts.UpdatedBy", updatedBy);
    return query;
  }
}
