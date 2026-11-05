import { Injectable, Logger } from "@nestjs/common";
import { Knex } from "knex";
import { phpRound } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { AccountLedgerService, LedgerEntityType } from "../../libraries/account-ledger/account-ledger.service";
import { CustomerBalanceService } from "../../libraries/customer-balance/customer-balance.service";
import { DocumentJournal, JournalService, SaleJournal } from "../../libraries/journal/journal.service";
import { DocumentLine, DOCUMENT_STOCK_MOVEMENT, StockLedgerService } from "../../libraries/stock-ledger/stock-ledger.service";
import { VendorBalanceService } from "../../libraries/vendor-balance/vendor-balance.service";
import { CustomerCacheService } from "../customers/customer-cache.service";
import { ProductCacheService } from "../products/product-cache.service";
import { VendorCacheService } from "../vendors/vendor-cache.service";
import { DocumentPaymentsRepository } from "./document-payments.repository";
import { DocumentKind } from "./transaction-kinds";
import { TransactionsRepository } from "./transactions.repository";

type Row = Record<string, unknown>;

export type LedgerSide = "Debit" | "Credit";

// One party-ledger movement (CI3 Accountledger::applyLedgerEntry)
export interface PartyLedgerEntry {
  partyUID: number;
  amount: number;
  side: LedgerSide;
  transUID: number;
}

export interface VendorLedgerEntry {
  vendorUID: number;
  amount: number;
  side: LedgerSide;
  transUID: number;
}

// Delivery challan statuses that took stock out (CI3 Transactions::_deleteSingleTransaction)
const DC_STOCK_OUT = ["Dispatched", "Delivered", "Partially Returned", "Converted"];

const lineProduct = (line: DocumentLine) => {
  const productUID = Number(line.productUID ?? 0) || 0;
  return productUID > 0 ? Math.trunc(productUID) : Math.trunc(Number(line.id ?? 0) || 0);
};

/**
 * What a saved, changed or removed document does outside its own rows (CI3 MY_Controller / Dbwrite_ext_model
 * helpers): stock movements, product / customer / vendor cache refreshes, the party's ledger balance and journals,
 * and the customer / vendor balance recalculation. Ledger, journal, cache and balance work never fails the save.
 */
@Injectable()
export class DocumentEffectsService {
  private readonly logger = new Logger(DocumentEffectsService.name);

  constructor(
    private readonly stock: StockLedgerService,
    private readonly journal: JournalService,
    private readonly ledgers: AccountLedgerService,
    private readonly vendorBalance: VendorBalanceService,
    private readonly customerBalance: CustomerBalanceService,
    private readonly productCache: ProductCacheService,
    private readonly vendorCache: VendorCacheService,
    private readonly customerCache: CustomerCacheService,
    private readonly orgSettings: OrgSettingsService,
    private readonly payments: DocumentPaymentsRepository,
    private readonly reads: TransactionsRepository
  ) {}

  // The module moves stock (Invoices / Purchase Returns / Challans out; Purchases / Sales Returns in)
  movesStock(kind: DocumentKind): boolean {
    return !!DOCUMENT_STOCK_MOVEMENT[kind.moduleUID];
  }

  // saveStockMovements — inside the document's transaction
  saveStock(trx: Knex.Transaction, kind: DocumentKind, ctx: WriteContext, transUID: number, lines: DocumentLine[]): Promise<void> {
    return this.stock.saveDocument(trx, { orgUID: ctx.orgUID, userUID: ctx.userUID, transUID, moduleUID: kind.moduleUID, lines });
  }

  // reverseStockMovements — inside the document's transaction; returns the products whose stock moved back
  reverseStock(trx: Knex.Transaction, kind: DocumentKind, ctx: WriteContext, transUID: number): Promise<number[]> {
    return this.stock.reverseDocument(trx, ctx.orgUID, transUID, kind.moduleUID, ctx.userUID);
  }

  // _syncProductCacheFromItems / upsertProduct — after the commit, so the cache sees the new stock
  async refreshProducts(orgUID: number, productUIDs: number[]): Promise<void> {
    for (const productUID of [...new Set(productUIDs.filter((uid) => uid > 0))]) await this.productCache.refreshProduct(orgUID, productUID);
  }

  refreshLineProducts(orgUID: number, lines: DocumentLine[], alsoProducts: number[] = []): Promise<void> {
    return this.refreshProducts(orgUID, [...alsoProducts, ...lines.map(lineProduct)]);
  }

  // touchVendor
  async refreshVendor(orgUID: number, vendorUID: number): Promise<void> {
    if (vendorUID > 0) await this.vendorCache.refresh(orgUID, vendorUID);
  }

  // _recalcVendorBalance — Vendorbalance::recalcAndSync, then the vendor's cache entry
  async recalcVendor(ctx: WriteContext, vendorUID: number): Promise<void> {
    if (vendorUID <= 0) return;
    try {
      await this.vendorBalance.recalcAndSync(ctx.orgUID, vendorUID, ctx.userUID);
    } catch (err) {
      this.logger.error(`Vendor ${vendorUID} balance recalculation failed: ${(err as Error).message}`);
    }
    await this.vendorCache.refresh(ctx.orgUID, vendorUID);
  }

  // _recalcCustomerBalance — Customerbalance::recalcAndSync (which also refreshes the customer's cache entry)
  async recalcCustomer(ctx: WriteContext, customerUID: number): Promise<{ balance: number; type: string } | null> {
    if (customerUID <= 0) return null;
    let result: { balance: number; type: string } | null = null;
    try {
      result = await this.customerBalance.recalcAndSync(ctx.orgUID, customerUID, ctx.userUID);
    } catch (err) {
      this.logger.error(`Customer ${customerUID} balance recalculation failed: ${(err as Error).message}`);
    }
    try {
      await this.customerCache.refresh(ctx.orgUID, (await this.orgSettings.get(ctx.orgUID)).OrgToken, customerUID);
    } catch (err) {
      this.logger.warn(`Customer cache refresh for ${customerUID} failed: ${(err as Error).message}`);
    }
    return result;
  }

  /**
   * The party-ledger movements and journal work CI3 runs after its commit inside one try: here they share one
   * transaction, so a failure (e.g. a party without a ledger) is logged and leaves nothing half-applied.
   */
  postPartyAccounts(label: string, ctx: WriteContext, entityType: LedgerEntityType, entries: PartyLedgerEntry[], journals: (trx: Knex.Transaction) => Promise<void> = async () => undefined): Promise<void> {
    return this.journal.postAfterSave(label, async (trx) => {
      for (const entry of entries) await this.ledgers.applyBalanceEntry(trx, ctx, entityType, entry.partyUID, entry.amount, entry.side, entry.transUID);
      await journals(trx);
    });
  }

  postVendorAccounts(label: string, ctx: WriteContext, entries: VendorLedgerEntry[], journals?: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
    return this.postPartyAccounts(label, ctx, "Vendor", entries.map((entry) => ({ partyUID: entry.vendorUID, amount: entry.amount, side: entry.side, transUID: entry.transUID })), journals);
  }

  postPurchaseJournal(trx: Knex.Transaction, bill: DocumentJournal): Promise<void> {
    return this.journal.postPurchase(trx, bill);
  }

  postPurchaseReturnJournal(trx: Knex.Transaction, ret: DocumentJournal): Promise<void> {
    return this.journal.postPurchaseReturn(trx, ret);
  }

  postSaleJournal(trx: Knex.Transaction, sale: SaleJournal): Promise<void> {
    return this.journal.postSale(trx, sale);
  }

  postSaleReturnJournal(trx: Knex.Transaction, ret: SaleJournal): Promise<void> {
    return this.journal.postSaleReturn(trx, ret);
  }

  // postPaymentJournal('received' / 'made') — referenced to the document, as CI3 does for form payments
  postPaymentJournal(trx: Knex.Transaction, ctx: WriteContext, direction: "made" | "received", transUID: number, date: string, financialYear: number, amount: number, partyUID: number, entityType: LedgerEntityType) {
    return this.journal.postPayment(trx, { orgUID: ctx.orgUID, direction, paymentUID: transUID, date, financialYear, amount, partyUID, entityType, userUID: ctx.userUID });
  }

  reverseJournal(trx: Knex.Transaction, ctx: WriteContext, referenceType: string, transUID: number): Promise<void> {
    return this.journal.reverse(trx, ctx.orgUID, referenceType, transUID, ctx.userUID);
  }

  // ── deleteMultipleTransactions (Transactions::_deleteSingleTransaction) ──

  // Sales returns: refused while their credit is applied to an invoice
  async checkBulkDelete(kind: DocumentKind, ctx: WriteContext, existing: Row): Promise<void> {
    if (kind.moduleUID !== 106) return;
    const number = String(existing.UniqueNumber ?? "");
    if (number && ((await this.payments.creditAppliedByNumbers(ctx.orgUID, [number])).get(number) ?? 0) > 0) {
      throw new CiValidationError("SR has credit applied to invoices. Reverse allocations first.");
    }
    if (await this.payments.salesReturnCreditNoteApplied(ctx.orgUID, Number(existing.TransUID))) throw new CiValidationError("SR credit note is applied to an invoice. Reverse it first.");
  }

  /**
   * Inside each delete: stock is reversed for Invoices, Purchases, Sales / Purchase Returns and for challans whose
   * goods went out; a sales return's payments and Pending credit note are removed. Returns the products moved back.
   */
  async insideBulkDelete(trx: Knex.Transaction, kind: DocumentKind, ctx: WriteContext, existing: Row): Promise<number[]> {
    const transUID = Number(existing.TransUID);
    let products: number[] = [];
    if ([103, 105, 106, 108].includes(kind.moduleUID) || (kind.moduleUID === 112 && DC_STOCK_OUT.includes(String(existing.DocStatus)))) {
      products = await this.reverseStock(trx, kind, ctx, transUID);
    }
    if (kind.moduleUID === 106) {
      await this.payments.voidAllPayments(trx, ctx.orgUID, transUID, "delete", ctx.userUID);
      await this.payments.retireSalesReturnCreditNotes(trx, ctx.orgUID, transUID, "delete", ctx.userUID);
    }
    return products;
  }

  /**
   * After each commit: products refreshed. A saved invoice credits back its unpaid part and reverses its journal;
   * a saved purchase bill debits its whole amount back and reverses its journal (vendor balance recalculated);
   * a sales return recalculates the customer and reverses its journal; a purchase return recalculates the vendor
   * and reverses its journal.
   */
  async afterBulkDelete(kind: DocumentKind, ctx: WriteContext, existing: Row, reversedProducts: number[]): Promise<void> {
    await this.refreshProducts(ctx.orgUID, reversedProducts);
    const partyUID = Number(existing.PartyUID) || 0;
    const transUID = Number(existing.TransUID);
    const saved = existing.DocStatus !== "Draft";
    if (kind.moduleUID === 103 && saved && existing.PartyType === "C" && partyUID > 0) {
      const paid = (await this.reads.payments(ctx.orgUID, transUID)).reduce((total, payment) => total + (Number(payment.Amount) || 0), 0);
      const remaining = Math.max(0, phpRound((Number(existing.NetAmount) || 0) - paid, AMOUNT_DECIMALS));
      await this.postPartyAccounts("Invoice delete", ctx, "Customer", remaining > 0 ? [{ partyUID, amount: remaining, side: "Credit", transUID }] : [], (trx) => this.reverseJournal(trx, ctx, "Invoice", transUID));
    }
    if (kind.moduleUID === 105 && saved && existing.PartyType === "S" && partyUID > 0) {
      await this.postVendorAccounts("Purchase delete", ctx, [{ vendorUID: partyUID, amount: Number(existing.NetAmount) || 0, side: "Debit", transUID }], (trx) => this.reverseJournal(trx, ctx, "Purchase", transUID));
      await this.recalcVendor(ctx, partyUID);
    }
    if (kind.moduleUID === 106 && partyUID > 0) {
      await this.recalcCustomer(ctx, partyUID);
      await this.journal.postAfterSave("Sales return delete", (trx) => this.reverseJournal(trx, ctx, "SalesReturn", transUID));
    }
    if (kind.moduleUID === 108 && partyUID > 0) {
      await this.recalcVendor(ctx, partyUID);
      await this.journal.postAfterSave("Purchase return delete", (trx) => this.reverseJournal(trx, ctx, "PurchaseReturn", transUID));
    }
  }
}
