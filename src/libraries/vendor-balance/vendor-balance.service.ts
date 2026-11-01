import { Injectable } from "@nestjs/common";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { phpRound } from "../../common/utils/php-compat";
import { VendorBalanceBase, VendorBalanceRepository } from "./vendor-balance.repository";

export type VendorBalanceType = "Debit" | "Credit";

interface SignedBalance {
  balance: number;
  type: VendorBalanceType;
}

// Vendor opening: Credit (we owe the vendor) = positive, Debit = negative
const signedOpeningOf = (vendor: VendorBalanceBase) => (vendor.OpeningBalType === "Credit" ? 1 : -1) * Number(vendor.OpeningBalance);

const toBalance = (signed: number): SignedBalance => ({ balance: Math.abs(signed), type: signed >= 0 ? "Credit" : "Debit" });

/**
 * Vendor balance calculations (CI3 Vendorbalance library). Shared by every module that changes a
 * vendor's balance — Vendors now, Purchases / Payments / Purchase Returns later.
 */
@Injectable()
export class VendorBalanceService {
  constructor(private readonly balances: VendorBalanceRepository) {}

  /**
   * recalcAndSync — recomputes the closing balance and stores it in VendOpeningBalanceTbl.PendingBalance
   * and the ledger's CurrentBalance:
   *   opening + purchased − paid − (returned − returns already covered by a debit note)
   *   − pending debit notes + pending credit notes.
   * The caller refreshes the vendor cache afterwards. Returns null when the vendor is not active.
   */
  async recalcAndSync(orgUID: number, vendorUID: number, userUID: number): Promise<SignedBalance | null> {
    const [vendor] = await this.balances.findBalanceBase(orgUID, vendorUID);
    if (!vendor) return null;

    const [purchased, paid, returned, coveredByDebitNote, notes] = await Promise.all([
      this.balances.totalPurchased(orgUID, vendorUID),
      this.balances.totalPaid(orgUID, vendorUID),
      this.balances.totalReturned(orgUID, vendorUID),
      this.balances.purchaseReturnsCoveredByDebitNote(orgUID, vendorUID),
      this.balances.pendingNoteTotals(orgUID, vendorUID),
    ]);
    const effectiveReturned = Math.max(0, returned - coveredByDebitNote);
    const result = toBalance(
      phpRound(signedOpeningOf(vendor) + purchased - paid - effectiveReturned - notes.debit + notes.credit, AMOUNT_DECIMALS)
    );
    await this.store(orgUID, vendor, result, userUID);
    return result;
  }

  /**
   * updateVendorBalance — stores opening + purchased − paid − returned for one vendor, or every active
   * vendor when vendorUID is 0. A failure on one vendor is reported and the rest continue.
   */
  async storeLiveBalances(orgUID: number, vendorUID: number, userUID: number) {
    const vendors = await this.balances.findBalanceBase(orgUID, vendorUID);
    let updated = 0;
    const errors: string[] = [];
    for (const vendor of vendors) {
      try {
        const uid = Number(vendor.VendorUID);
        const [purchased, paid, returned] = await Promise.all([
          this.balances.totalPurchased(orgUID, uid),
          this.balances.totalPaid(orgUID, uid),
          this.balances.totalReturned(orgUID, uid),
        ]);
        await this.store(orgUID, vendor, toBalance(phpRound(signedOpeningOf(vendor) + purchased - paid - returned, AMOUNT_DECIMALS)), userUID);
        updated++;
      } catch (err) {
        errors.push(`VendorUID ${vendor.VendorUID}: ${(err as Error).message}`);
      }
    }
    return { found: vendors.length, updated, skipped: errors.length, errors };
  }

  // getVendorTotalPaid — money paid out to the vendor (profile overview)
  totalPaid(orgUID: number, vendorUID: number): Promise<number> {
    return this.balances.totalPaid(orgUID, vendorUID);
  }

  // Closing balance → VendOpeningBalanceTbl.PendingBalance and the ledger's CurrentBalance
  private async store(orgUID: number, vendor: VendorBalanceBase, result: SignedBalance, userUID: number) {
    if (vendor.LedgerUID) {
      await this.balances.saveLedgerBalance(Number(vendor.LedgerUID), result.balance, result.type, userUID);
    }
    await this.balances.savePendingBalance(orgUID, Number(vendor.VendorUID), result.balance, result.type, userUID);
  }
}
