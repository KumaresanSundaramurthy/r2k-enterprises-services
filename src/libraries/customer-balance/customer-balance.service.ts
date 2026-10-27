import { Injectable } from "@nestjs/common";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { CiValidationError } from "../../core/response/ci-response";
import { phpRound } from "../../common/utils/php-compat";
import { CustomerBalanceBase, CustomerBalanceRepository } from "./customer-balance.repository";

export type BalanceType = "Debit" | "Credit";

interface SignedBalance {
  balance: number;
  type: BalanceType;
}

const signedOpeningOf = (customer: CustomerBalanceBase) =>
  (customer.OpeningBalType === "Debit" ? 1 : -1) * Number(customer.OpeningBalance);

// Signed amount → { balance, type }: positive = customer owes us (Debit)
const toBalance = (signed: number): SignedBalance => ({ balance: Math.abs(signed), type: signed >= 0 ? "Debit" : "Credit" });

/**
 * Customer balance calculations (CI3 Customerbalance library). Shared by every module that needs a
 * customer's balance — Customers now, Invoices / Payments / Sales Returns later.
 */
@Injectable()
export class CustomerBalanceService {
  constructor(private readonly balances: CustomerBalanceRepository) {}

  /**
   * recalcAndSync — recomputes the closing balance and stores it in CustOpeningBalanceTbl.PendingBalance
   * and the ledger's CurrentBalance:
   *   opening + invoiced − received − (returned − returns already covered by a credit note)
   *   − open credit notes + pending debit notes.
   * The caller refreshes the customer cache afterwards. Returns null when the customer is not active.
   */
  async recalcAndSync(orgUID: number, customerUID: number, userUID: number): Promise<SignedBalance | null> {
    const [customer] = await this.balances.findBalanceBase(orgUID, customerUID);
    if (!customer) return null;

    const [totalInvoiced, totalReceived, totalReturned, coveredByCreditNote, notes] = await Promise.all([
      this.balances.totalInvoiced(orgUID, customerUID),
      this.balances.totalReceived(orgUID, customerUID),
      this.balances.totalReturned(orgUID, customerUID),
      this.balances.salesReturnsCoveredByCreditNote(orgUID, customerUID),
      this.balances.pendingNoteTotals(orgUID, customerUID),
    ]);
    const effectiveReturned = Math.max(0, totalReturned - coveredByCreditNote);
    const result = toBalance(
      phpRound(signedOpeningOf(customer) + totalInvoiced - totalReceived - effectiveReturned - notes.credit + notes.debit, AMOUNT_DECIMALS)
    );
    await this.store(orgUID, customer, result, userUID);
    return result;
  }

  /**
   * Live balance (CI3 Customers::getCustomerBalance):
   * opening (Debit +, Credit −) + invoiced − received − returned.
   */
  async getLiveBalance(orgUID: number, customerUID: number) {
    const [customer] = await this.balances.findBalanceBase(orgUID, customerUID);
    if (!customer) {
      throw new CiValidationError("Customer not found.");
    }
    const { result, totals } = await this.simpleBalance(orgUID, customer);
    return {
      CustomerUID: customerUID,
      Balance: result.balance,
      BalanceType: result.type,
      Breakdown: {
        OpeningBalance: Number(customer.OpeningBalance),
        OpeningBalType: customer.OpeningBalType,
        TotalInvoiced: totals.invoiced,
        TotalReceived: totals.received,
        TotalReturned: totals.returned,
      },
    };
  }

  /**
   * updateCustomerBalance — stores the live (simple formula) balance for one customer, or every active
   * customer when customerUID is 0. A failure on one customer is reported and the rest continue.
   */
  async storeLiveBalances(orgUID: number, customerUID: number, userUID: number) {
    const customers = await this.balances.findBalanceBase(orgUID, customerUID);
    let updated = 0;
    const errors: string[] = [];
    for (const customer of customers) {
      try {
        const { result } = await this.simpleBalance(orgUID, customer);
        await this.store(orgUID, customer, result, userUID);
        updated++;
      } catch (err) {
        errors.push(`CustomerUID ${customer.CustomerUID}: ${(err as Error).message}`);
      }
    }
    return { found: customers.length, updated, skipped: errors.length, errors };
  }

  // getCustomerTotalReceived — money received from the customer (same rules as the balance)
  totalReceived(orgUID: number, customerUID: number): Promise<number> {
    return this.balances.totalReceived(orgUID, customerUID);
  }

  // Advance (unused excess payments) and pending credit notes, rounded like CI3 Cachehelper (4 decimals).
  async getCreditTotals(orgUID: number, customerUID: number) {
    const [advance, creditNotes] = await Promise.all([
      this.balances.advanceTotal(orgUID, customerUID),
      this.balances.pendingCreditNoteTotal(orgUID, customerUID),
    ]);
    return { AdvanceTotal: phpRound(advance, 4), CreditNoteTotal: phpRound(creditNotes, 4) };
  }

  private async simpleBalance(orgUID: number, customer: CustomerBalanceBase) {
    const customerUID = Number(customer.CustomerUID);
    const [invoiced, received, returned] = await Promise.all([
      this.balances.totalInvoiced(orgUID, customerUID),
      this.balances.totalReceived(orgUID, customerUID),
      this.balances.totalReturned(orgUID, customerUID),
    ]);
    const result = toBalance(phpRound(signedOpeningOf(customer) + invoiced - received - returned, AMOUNT_DECIMALS));
    return { result, totals: { invoiced, received, returned } };
  }

  // Closing balance → CustOpeningBalanceTbl.PendingBalance and the ledger's CurrentBalance
  private async store(orgUID: number, customer: CustomerBalanceBase, result: SignedBalance, userUID: number) {
    if (customer.LedgerUID) {
      await this.balances.saveLedgerBalance(Number(customer.LedgerUID), result.balance, result.type, userUID);
    }
    await this.balances.savePendingBalance(orgUID, Number(customer.CustomerUID), result.balance, result.type, userUID);
  }
}
