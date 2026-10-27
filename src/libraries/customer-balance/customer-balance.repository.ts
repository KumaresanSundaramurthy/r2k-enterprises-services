import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { MODULE_UID } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";

export interface CustomerBalanceBase {
  CustomerUID: string;
  OpeningBalance: string;
  OpeningBalType: string;
  LedgerUID: string | null;
  LedgerCurrentBalance: string | null;
  LedgerCurrentType: string | null;
}

/** Totals behind a customer's closing balance (CI3 Customers_model balance queries, used by Customerbalance). */
@Injectable()
export class CustomerBalanceRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getCustomersWithLedgerForBalance — opening balance and linked ledger of active customers (one or all).
  async findBalanceBase(orgUID: number, customerUID = 0): Promise<CustomerBalanceBase[]> {
    const query = this.read("Customers.CustomerTbl as C")
      .select(
        "C.CustomerUID as CustomerUID",
        this.read.raw("IFNULL(??, 0.00) AS ??", ["COB.OpeningBalance", "OpeningBalance"]),
        this.read.raw("IFNULL(??, 'Debit') AS ??", ["COB.OpeningBalType", "OpeningBalType"]),
        "ELM.LedgerUID as LedgerUID",
        "COA.CurrentBalance as LedgerCurrentBalance",
        "COA.CurrentBalanceType as LedgerCurrentType"
      )
      .leftJoin("Customers.CustOpeningBalanceTbl as COB", (on) => {
        on.on("COB.CustomerUID", "C.CustomerUID").andOnVal("COB.IsDeleted", "=", 0);
      })
      .leftJoin("Accounting.EntityLedgerMap as ELM", (on) => {
        on.on("ELM.CustomerUID", "C.CustomerUID").andOnVal("ELM.EntityType", "=", "Customer").andOnVal("ELM.IsDeleted", "=", 0);
      })
      .leftJoin("Accounting.ChartOfAccounts as COA", (on) => {
        on.on("COA.LedgerUID", "ELM.LedgerUID").andOnVal("COA.IsDeleted", "=", 0);
      })
      .where({ "C.OrgUID": orgUID, "C.IsDeleted": 0, "C.IsActive": 1 });
    if (customerUID > 0) query.where("C.CustomerUID", customerUID);
    return query;
  }

  // getCustomerTotalInvoiced — invoices that count towards the balance (not Draft, Cancelled or Rejected).
  async totalInvoiced(orgUID: number, customerUID: number): Promise<number> {
    const row = await this.read("Transaction.TransactionsTbl")
      .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["NetAmount", "total"]))
      .where({ OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", ModuleUID: MODULE_UID.Invoices, IsDeleted: 0 })
      .whereNotIn("DocStatus", ["Draft", "Cancelled", "Rejected"])
      .first();
    return Number(row?.total ?? 0);
  }

  // getCustomerTotalReceived — money received, excluding credit-note transfers, cancelled payments and advance allocations.
  async totalReceived(orgUID: number, customerUID: number): Promise<number> {
    const row = await this.read("Transaction.PaymentsTbl")
      .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["Amount", "total"]))
      .where({
        OrgUID: orgUID,
        PartyUID: customerUID,
        PartyType: "C",
        PaymentDirection: "In",
        IsDeleted: 0,
        IsTransferredToCreditNote: 0,
        IsCancelled: 0,
        IsExcessApplied: 0,
      })
      // Credit-note payments are counted through TransCreditNoteTbl, not here
      .where((group) => group.whereNull("SourceType").orWhereNot("SourceType", "CreditNote"))
      .first();
    return Number(row?.total ?? 0);
  }

  // getCustomerAdvanceTotal — unused excess payments (overpayments not yet applied to an invoice).
  async advanceTotal(orgUID: number, customerUID: number): Promise<number> {
    const row = await this.read("Transaction.PaymentsTbl")
      .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["ExcessAmount", "total"]))
      .where({ OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", PaymentDirection: "In", IsExcessApplied: 0, IsDeleted: 0, IsCancelled: 0 })
      .where("ExcessAmount", ">", 0)
      .first();
    return Number(row?.total ?? 0);
  }

  // getCustomerCreditNoteTotal — credit notes not yet applied.
  async pendingCreditNoteTotal(orgUID: number, customerUID: number): Promise<number> {
    const row = await this.read("Transaction.TransCreditNoteTbl")
      .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["Amount", "total"]))
      .where({ OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", Status: "Pending", IsDeleted: 0, IsCancelled: 0 })
      .first();
    return Number(row?.total ?? 0);
  }

  // getCustomerSRCoveredByCreditNote — sales returns already turned into a (non-cancelled) credit note.
  async salesReturnsCoveredByCreditNote(orgUID: number, customerUID: number): Promise<number> {
    const row = await this.read("Transaction.TransactionsTbl as T")
      .select(this.read.raw("COALESCE(SUM(COALESCE(??, ??)), 0) AS ??", ["T.BalanceAmount", "T.NetAmount", "total"]))
      .join("Transaction.TransCreditNoteTbl as CN", (on) => {
        on.on("CN.SourceTransUID", "T.TransUID")
          .andOnVal("CN.SourceModuleUID", "=", MODULE_UID.SalesReturns)
          .andOnVal("CN.IsDeleted", "=", 0)
          .andOnVal("CN.OrgUID", "=", orgUID);
      })
      .where({ "T.OrgUID": orgUID, "T.PartyUID": customerUID, "T.PartyType": "C", "T.IsDeleted": 0, "T.ModuleUID": MODULE_UID.SalesReturns })
      .whereNotIn("T.DocStatus", ["Cancelled", "Rejected"])
      .where("CN.IsCancelled", 0)
      .first();
    return Number(row?.total ?? 0);
  }

  // getCustomerPendingNoteTotals — open credit notes (Pending/Applied, not cleared) and pending debit notes.
  async pendingNoteTotals(orgUID: number, customerUID: number): Promise<{ credit: number; debit: number }> {
    const [credit, debit] = await Promise.all([
      this.read("Transaction.TransCreditNoteTbl")
        .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["Amount", "total"]))
        .where({ OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", IsCancelled: 0, IsDeleted: 0, PaymentCleared: 0 })
        .whereIn("Status", ["Pending", "Applied"])
        .first(),
      this.read("Transaction.TransDebitNoteTbl")
        .select(this.read.raw("COALESCE(SUM(??), 0) AS ??", ["Amount", "total"]))
        .where({ OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", Status: "Pending", IsDeleted: 0 })
        .first(),
    ]);
    return { credit: Number(credit?.total ?? 0), debit: Number(debit?.total ?? 0) };
  }

  // updateCustomerPendingBalance — upsert of the closing balance (unique OrgUID + CustomerUID).
  async savePendingBalance(orgUID: number, customerUID: number, balance: number, balanceType: string, userUID: number): Promise<void> {
    await this.writer()("Customers.CustOpeningBalanceTbl")
      .insert({
        OrgUID: orgUID,
        CustomerUID: customerUID,
        OpeningBalance: 0,
        OpeningBalType: "Debit",
        PendingBalance: balance,
        PendingBalType: balanceType,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      })
      .onConflict(["OrgUID", "CustomerUID"])
      .merge({ PendingBalance: balance, PendingBalType: balanceType, UpdatedBy: userUID });
  }

  // updateCustomerBalanceInLedger
  async saveLedgerBalance(ledgerUID: number, balance: number, balanceType: string, userUID: number): Promise<void> {
    await this.writer()("Accounting.ChartOfAccounts")
      .where({ LedgerUID: ledgerUID })
      .update({ CurrentBalance: balance, CurrentBalanceType: balanceType, UpdatedBy: userUID });
  }

  // getCustomerTotalReturned — outstanding amount of sales returns and credit notes.
  async totalReturned(orgUID: number, customerUID: number): Promise<number> {
    const row = await this.read("Transaction.TransactionsTbl")
      .select(this.read.raw("COALESCE(SUM(COALESCE(??, ??)), 0) AS ??", ["BalanceAmount", "NetAmount", "total"]))
      .where({ OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", IsDeleted: 0 })
      .whereIn("ModuleUID", [MODULE_UID.SalesReturns, MODULE_UID.CreditNotes])
      .whereNotIn("DocStatus", ["Cancelled", "Rejected"])
      .first();
    return Number(row?.total ?? 0);
  }
}
