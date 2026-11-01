import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { MODULE_UID } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";

export interface VendorBalanceBase {
  VendorUID: string;
  OpeningBalance: string;
  OpeningBalType: string;
  LedgerUID: string | null;
  LedgerCurrentBalance: string | null;
  LedgerCurrentType: string | null;
}

// Vendor documents count unless cancelled or rejected
const VOID_STATUSES = ["Cancelled", "Rejected"];

/** Totals behind a vendor's closing balance (CI3 Vendors_model balance queries, used by Vendorbalance). PartyType 'S' = supplier. */
@Injectable()
export class VendorBalanceRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getVendorsWithLedgerForBalance — opening balance and linked ledger of active vendors (one or all).
  async findBalanceBase(orgUID: number, vendorUID = 0): Promise<VendorBalanceBase[]> {
    const query = this.read("Vendors.VendorTbl as V")
      .select(
        "V.VendorUID as VendorUID",
        this.read.raw("IFNULL(??, 0.00) AS ??", ["VOB.OpeningBalance", "OpeningBalance"]),
        this.read.raw("IFNULL(??, 'Credit') AS ??", ["VOB.OpeningBalType", "OpeningBalType"]),
        "ELM.LedgerUID as LedgerUID",
        "COA.CurrentBalance as LedgerCurrentBalance",
        "COA.CurrentBalanceType as LedgerCurrentType"
      )
      .leftJoin("Vendors.VendOpeningBalanceTbl as VOB", (on) => {
        on.on("VOB.VendorUID", "V.VendorUID").andOnVal("VOB.IsDeleted", "=", 0);
      })
      .leftJoin("Accounting.EntityLedgerMap as ELM", (on) => {
        on.on("ELM.VendorUID", "V.VendorUID").andOnVal("ELM.EntityType", "=", "Vendor").andOnVal("ELM.IsDeleted", "=", 0);
      })
      .leftJoin("Accounting.ChartOfAccounts as COA", (on) => {
        on.on("COA.LedgerUID", "ELM.LedgerUID").andOnVal("COA.IsDeleted", "=", 0);
      })
      .where({ "V.OrgUID": orgUID, "V.IsDeleted": 0, "V.IsActive": 1 });
    if (vendorUID > 0) query.where("V.VendorUID", vendorUID);
    return query;
  }

  // getVendorTotalPurchased — purchases (not cancelled or rejected)
  async totalPurchased(orgUID: number, vendorUID: number): Promise<number> {
    const row = await this.read("Transaction.TransactionsTbl")
      .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["NetAmount", "total"]))
      .where({ OrgUID: orgUID, PartyUID: vendorUID, PartyType: "S", ModuleUID: MODULE_UID.Purchases, IsDeleted: 0 })
      .whereNotIn("DocStatus", VOID_STATUSES)
      .first();
    return Number(row?.total ?? 0);
  }

  // getVendorTotalPaid — money paid out to the vendor
  async totalPaid(orgUID: number, vendorUID: number): Promise<number> {
    const row = await this.read("Transaction.PaymentsTbl")
      .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["Amount", "total"]))
      .where({ OrgUID: orgUID, PartyUID: vendorUID, PartyType: "S", IsCancelled: 0, IsDeleted: 0 })
      .first();
    return Number(row?.total ?? 0);
  }

  // getVendorTotalReturned — purchase returns and debit notes
  async totalReturned(orgUID: number, vendorUID: number): Promise<number> {
    const row = await this.read("Transaction.TransactionsTbl")
      .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["NetAmount", "total"]))
      .where({ OrgUID: orgUID, PartyUID: vendorUID, PartyType: "S", IsDeleted: 0 })
      .whereIn("ModuleUID", [MODULE_UID.PurchaseReturns, MODULE_UID.DebitNotes])
      .whereNotIn("DocStatus", VOID_STATUSES)
      .first();
    return Number(row?.total ?? 0);
  }

  // getVendorPRCoveredByDebitNote — purchase returns already turned into a (non-cancelled) debit note
  async purchaseReturnsCoveredByDebitNote(orgUID: number, vendorUID: number): Promise<number> {
    const row = await this.read("Transaction.TransactionsTbl as T")
      .select(this.read.raw("COALESCE(SUM(COALESCE(??, ??)), 0) AS ??", ["T.BalanceAmount", "T.NetAmount", "total"]))
      .join("Transaction.TransDebitNoteTbl as DN", (on) => {
        on.on("DN.SourceTransUID", "T.TransUID")
          .andOnVal("DN.SourceModuleUID", "=", MODULE_UID.PurchaseReturns)
          .andOnVal("DN.IsDeleted", "=", 0)
          .andOnVal("DN.OrgUID", "=", orgUID);
      })
      .where({ "T.OrgUID": orgUID, "T.PartyUID": vendorUID, "T.PartyType": "S", "T.IsDeleted": 0, "T.ModuleUID": MODULE_UID.PurchaseReturns })
      .whereNotIn("T.DocStatus", VOID_STATUSES)
      .where("DN.IsCancelled", 0)
      .first();
    return Number(row?.total ?? 0);
  }

  // getVendorPendingNoteTotals — pending debit notes (vendor owes us) and pending credit notes (we owe the vendor)
  async pendingNoteTotals(orgUID: number, vendorUID: number): Promise<{ debit: number; credit: number }> {
    const pending = { OrgUID: orgUID, PartyUID: vendorUID, PartyType: "S", Status: "Pending", IsDeleted: 0 };
    const [debit, credit] = await Promise.all([
      this.read("Transaction.TransDebitNoteTbl").select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["Amount", "total"])).where(pending).first(),
      this.read("Transaction.TransCreditNoteTbl").select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["Amount", "total"])).where(pending).first(),
    ]);
    return { debit: Number(debit?.total ?? 0), credit: Number(credit?.total ?? 0) };
  }

  // updateVendorPendingBalance — upsert of the closing balance (unique OrgUID + VendorUID)
  async savePendingBalance(orgUID: number, vendorUID: number, balance: number, balanceType: string, userUID: number): Promise<void> {
    await this.writer()("Vendors.VendOpeningBalanceTbl")
      .insert({
        OrgUID: orgUID,
        VendorUID: vendorUID,
        OpeningBalance: 0,
        OpeningBalType: "Credit",
        PendingBalance: balance,
        PendingBalType: balanceType,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      })
      .onConflict(["OrgUID", "VendorUID"])
      .merge({ PendingBalance: balance, PendingBalType: balanceType, UpdatedBy: userUID });
  }

  // updateVendorBalanceInLedger
  async saveLedgerBalance(ledgerUID: number, balance: number, balanceType: string, userUID: number): Promise<void> {
    await this.writer()("Accounting.ChartOfAccounts")
      .where({ LedgerUID: ledgerUID })
      .update({ CurrentBalance: balance, CurrentBalanceType: balanceType, UpdatedBy: userUID });
  }
}
