import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { nowDateTime, phpRound } from "../../common/utils/php-compat";

export interface OnAccountPayment {
  PaymentUID: string;
  PartyUID: string;
  Amount: string;
}

/**
 * Payment ↔ transaction bookkeeping shared by Customers, Invoices and Payments
 * (CI3 Dbwrite_ext_model / Transactions_model payment helpers).
 */
@Injectable()
export class TransactionPaymentService {
  constructor(private readonly db: DatabaseService) {}

  // getOnAccountPayment — an unapplied (on-account) payment of this organisation
  async findOnAccountPayment(orgUID: number, paymentUID: number, trx?: Knex.Transaction): Promise<OnAccountPayment | null> {
    const row = await (trx ?? this.db.write)("Transaction.PaymentsTbl")
      .select("PaymentUID", "PartyUID", "Amount")
      .where({ PaymentUID: paymentUID, OrgUID: orgUID, IsOnAccount: 1, IsDeleted: 0, IsCancelled: 0 })
      .first();
    return row ?? null;
  }

  // applyOnAccountPayment — attaches the payment to the transaction
  async applyOnAccount(trx: Knex.Transaction, orgUID: number, paymentUID: number, transUID: number, userUID: number): Promise<void> {
    await trx("Transaction.PaymentsTbl")
      .where({ PaymentUID: paymentUID, OrgUID: orgUID })
      .update({ TransUID: transUID, IsOnAccount: 0, OnAccountAppliedTransUID: transUID, UpdatedBy: userUID });
  }

  /**
   * Recomputes a transaction's paid amount, balance and status (Paid / Partial / Issued) from its payments.
   * Reads inside the same transaction, so a payment attached a moment ago is included.
   */
  async refreshPaidStatus(trx: Knex.Transaction, orgUID: number, transUID: number, userUID: number): Promise<void> {
    const header = await trx("Transaction.TransactionsTbl")
      .select("NetAmount")
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    if (!header) return;

    const paidRow = await trx("Transaction.PaymentsTbl")
      .select(trx.raw("COALESCE(SUM(??), 0) AS ??", ["Amount", "TotalPaid"]))
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0, IsActive: 1, IsCancelled: 0 })
      .first();

    const netAmount = Number(header.NetAmount);
    const paid = phpRound(Number(paidRow?.TotalPaid ?? 0), AMOUNT_DECIMALS);
    const balance = Math.max(0, phpRound(netAmount - paid, AMOUNT_DECIMALS));
    const isFullyPaid = netAmount > 0 && balance <= 0 ? 1 : 0;
    const status = isFullyPaid ? "Paid" : paid > 0 ? "Partial" : "Issued";

    await trx("Transaction.TransactionsTbl")
      .where({ TransUID: transUID, OrgUID: orgUID })
      .update({ IsFullyPaid: isFullyPaid, PaidAmount: paid, BalanceAmount: balance, DocStatus: status, UpdatedBy: userUID, UpdatedOn: nowDateTime() });
  }
}
