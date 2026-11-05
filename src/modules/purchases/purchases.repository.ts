import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const PAYMENTS = "Transaction.PaymentsTbl";
const TRANSACTIONS = "Transaction.TransactionsTbl";
const PURCHASE_MODULE = 105;

// Purchase Payments list filter (the CI3 payments list filter)
export interface VendorPaymentFilter {
  Status?: string;
  PaymentSource?: string;
  DateFrom?: string;
  DateTo?: string;
  Search?: string;
  UpdatedByUIDs?: unknown;
  PaymentMode?: unknown;
  DocTypeModuleUIDs?: unknown;
  SortBy?: string;
  SortDir?: string;
}

const SORT_COLUMNS: Record<string, string> = { Date: "P.CreatedOn", Amount: "P.Amount", Type: "P.PaymentDirection", Party: "PartyName" };
const ints = (value: unknown): number[] =>
  ([] as unknown[])
    .concat(value ?? [])
    .map((item) => parseInt(String(item), 10))
    .filter((id) => id > 0);
const strings = (value: unknown): string[] => ([] as unknown[]).concat(value ?? []).map(String).filter((item) => item !== "");

/** Purchase-side reads and writes (CI3 Transactions_model purchase helpers, Purchases::_applyPurchasePriceUpdates). */
@Injectable()
export class PurchasesRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // _applyPurchasePriceUpdates — the product master's purchase price
  async setProductPurchasePrice(orgUID: number, productUID: number, price: number, userUID: number): Promise<number> {
    return this.writer()("Products.ProductTbl").where({ ProductUID: productUID, OrgUID: orgUID, IsDeleted: 0 }).update({ PurchasePrice: price, UpdatedBy: userUID });
  }

  // TransSettings.PurchaseCancelAction — what happens to a cancelled / deleted bill's payments (ask, debit_note, refund)
  async purchaseCancelAction(orgUID: number): Promise<string> {
    const row = await this.read("Settings.TransactionSettingsTbl").select("PurchaseCancelAction").where({ OrgUID: orgUID }).first();
    return String(row?.PurchaseCancelAction || "ask");
  }

  // ── Purchase Payments page (getPaymentsList / getPaymentsCount on vendor payments made) ──

  async vendorPayments(orgUID: number, filter: VendorPaymentFilter, limit: number, offset: number): Promise<Row[]> {
    const k = this.read;
    const query = this.paymentsBase(orgUID, filter)
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
        "V.Name as PartyName",
        "V.Area as PartyArea",
        "V.MobileNumber as PartyMobile",
        "V.CountryCode as PartyCountryCode",
        "V.EmailAddress as PartyEmail",
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
      .leftJoin("Transaction.PaymentsTbl as SrcPmt", (on) => on.on("SrcPmt.PaymentUID", "P.OnAccountSourcePaymentUID").andOnVal("SrcPmt.IsDeleted", "=", 0))
      .orderBy(SORT_COLUMNS[filter.SortBy ?? ""] ?? "P.PaymentUID", String(filter.SortDir ?? "DESC").toUpperCase() === "ASC" ? "asc" : "desc");
    if (limit > 0) query.limit(limit).offset(offset);
    return query;
  }

  async vendorPaymentCount(orgUID: number, filter: VendorPaymentFilter): Promise<number> {
    const row = await this.paymentsBase(orgUID, filter).count("* as cnt").first();
    return Number(row?.cnt ?? 0);
  }

  // The page's totals: money received from customers and paid to vendors among the listed payments
  async vendorPaymentTotals(orgUID: number, filter: VendorPaymentFilter): Promise<{ TotalReceived: number; TotalPaid: number }> {
    const row = await this.paymentsBase(orgUID, filter)
      .select(this.read.raw("COALESCE(SUM(CASE WHEN P.PartyType = 'C' THEN P.Amount ELSE 0 END), 0) AS TotalReceived"), this.read.raw("COALESCE(SUM(CASE WHEN P.PartyType = 'S' THEN P.Amount ELSE 0 END), 0) AS TotalPaid"))
      .first();
    return { TotalReceived: Number(row?.TotalReceived ?? 0), TotalPaid: Number(row?.TotalPaid ?? 0) };
  }

  // ── Purchase Return pickers ──────────────────────────────────────────

  // getVendorPurchasesWithReturnableItems — the vendor's saved bills with a line not yet fully returned
  async returnablePurchases(orgUID: number, vendorUID: number): Promise<Row[]> {
    const [rows] = await this.read.raw(
      `SELECT Ts.TransUID, Ts.UniqueNumber, Ts.TransDate, Ts.NetAmount, Ts.DocStatus
         FROM Transaction.TransactionsTbl AS Ts
        WHERE Ts.PartyUID = ? AND Ts.PartyType = 'S' AND Ts.ModuleUID = ? AND Ts.OrgUID = ?
          AND Ts.IsDeleted = 0 AND Ts.IsActive = 1 AND Ts.DocStatus NOT IN ('Draft', 'Cancelled')
          AND EXISTS (
              SELECT 1 FROM Transaction.TransProductsTbl AS IP
               WHERE IP.TransUID = Ts.TransUID AND IP.OrgUID = Ts.OrgUID AND IP.IsDeleted = 0 AND IP.IsActive = 1
                 AND IP.Quantity > COALESCE((
                     SELECT SUM(RP.Quantity) FROM Transaction.TransProductsTbl AS RP
                      WHERE RP.SourceTransProdUID = IP.TransProdUID AND RP.OrgUID = Ts.OrgUID AND RP.IsDeleted = 0 AND RP.IsActive = 1
                 ), 0))
        ORDER BY Ts.TransUID DESC`,
      [vendorUID, PURCHASE_MODULE, orgUID]
    );
    return rows as Row[];
  }

  // getVendorPendingPurchases — the vendor's bills with a balance still to pay
  pendingPurchases(orgUID: number, vendorUID: number): Promise<Row[]> {
    return this.read(`${TRANSACTIONS} as Ts`)
      .select("Ts.TransUID", "Ts.UniqueNumber", "Ts.TransDate", "Ts.NetAmount", this.read.raw("COALESCE(Ts.PaidAmount, 0) AS PaidAmount"), this.read.raw("COALESCE(Ts.BalanceAmount, 0) AS BalanceAmount"))
      .where({ "Ts.PartyUID": vendorUID, "Ts.PartyType": "S", "Ts.ModuleUID": PURCHASE_MODULE, "Ts.OrgUID": orgUID, "Ts.IsDeleted": 0, "Ts.IsActive": 1 })
      .whereNotIn("Ts.DocStatus", ["Draft", "Cancelled", "Paid"])
      .whereRaw("COALESCE(Ts.BalanceAmount, Ts.NetAmount) > 0")
      .orderBy("Ts.TransUID", "desc");
  }

  // Payments made to vendors (PartyType S, Out), or the cancelled / deleted ones on the Cancelled tab
  private paymentsBase(orgUID: number, filter: VendorPaymentFilter): Knex.QueryBuilder {
    const query = this.read(`${PAYMENTS} as P`)
      .leftJoin("Global.PaymentTypesTbl as PT", "PT.PaymentTypeUID", "P.PaymentTypeUID")
      .leftJoin("Transaction.TransactionsTbl as T", (on) => on.on("T.TransUID", "P.TransUID").andOnVal("T.IsDeleted", "=", 0))
      .leftJoin("Vendors.VendorTbl as V", (on) => on.on("V.VendorUID", "P.PartyUID").andOnVal("P.PartyType", "=", "S"))
      .where({ "P.OrgUID": orgUID, "P.PartyType": "S", "P.PaymentDirection": "Out" });
    if (filter.Status === "Cancelled") query.where((w) => w.where("P.IsCancelled", 1).orWhere("P.IsDeleted", 1));
    else query.where({ "P.IsDeleted": 0, "P.IsActive": 1, "P.IsCancelled": 0 });
    if (filter.PaymentSource) query.where("P.PaymentSource", filter.PaymentSource);
    if (filter.DateFrom) query.whereRaw("DATE(P.CreatedOn) >= ?", [filter.DateFrom]);
    if (filter.DateTo) query.whereRaw("DATE(P.CreatedOn) <= ?", [filter.DateTo]);
    if (filter.Search) this.whereAnyLike(query, ["T.UniqueNumber", "V.Name"], String(filter.Search));
    const createdBy = ints(filter.UpdatedByUIDs);
    if (createdBy.length > 0) query.whereIn("P.CreatedBy", createdBy);
    const modes = strings(filter.PaymentMode);
    if (modes.length > 0) query.whereIn("PT.Name", modes);
    const docModules = ints(filter.DocTypeModuleUIDs);
    if (docModules.length > 0) query.whereIn("P.ModuleUID", docModules);
    return query;
  }
}
