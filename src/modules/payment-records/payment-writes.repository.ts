import { Injectable } from "@nestjs/common";
import { Knex } from "knex";

type Row = Record<string, unknown>;

const PAYMENTS = "Transaction.PaymentsTbl";
const TRANSACTIONS = "Transaction.TransactionsTbl";
const CREDIT_NOTES = "Transaction.TransCreditNoteTbl";

/**
 * Payment writes and the row locks that keep concurrent payment changes apart (CI3 lock* / reduce* / restore*
 * helpers). Every method runs in the caller's transaction; the FOR UPDATE reads queue concurrent requests.
 */
@Injectable()
export class PaymentWritesRepository {
  // lockInvoiceForUpdate
  async lockTransaction(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<Row | null> {
    return (await trx(TRANSACTIONS).select("NetAmount", "PaidAmount", "DocStatus", "IsDeleted").where({ TransUID: transUID, OrgUID: orgUID }).forUpdate().first()) ?? null;
  }

  // lockExcessSourcePayment — the payment whose unused advance (ExcessAmount) is being spent
  async lockAdvanceSource(trx: Knex.Transaction, orgUID: number, paymentUID: number, partyUID: number, partyType: string): Promise<Row | null> {
    return (
      (await trx(PAYMENTS)
        .select("PaymentUID", "ExcessAmount", "IsDeleted", "IsCancelled")
        .where({ PaymentUID: paymentUID, OrgUID: orgUID, PartyUID: partyUID, PartyType: partyType })
        .forUpdate()
        .first()) ?? null
    );
  }

  // lockOnAccountSourcePayment — a live on-account credit with something left
  async lockOnAccountSource(trx: Knex.Transaction, orgUID: number, paymentUID: number, partyUID: number): Promise<Row | null> {
    return (
      (await trx(PAYMENTS)
        .select("PaymentUID", "Amount")
        .where({ PaymentUID: paymentUID, OrgUID: orgUID, PartyUID: partyUID, IsOnAccount: 1, IsDeleted: 0, IsCancelled: 0 })
        .where("Amount", ">", 0)
        .forUpdate()
        .first()) ?? null
    );
  }

  // lockPaymentForDelete — the payment's current state
  async lockPayment(trx: Knex.Transaction, orgUID: number, paymentUID: number): Promise<Row | null> {
    return (
      (await trx(PAYMENTS)
        .select("IsDeleted", "IsCancelled", "IsTransferredToCreditNote", "IsOnAccount", "IsExcessApplied")
        .where({ PaymentUID: paymentUID, OrgUID: orgUID })
        .forUpdate()
        .first()) ?? null
    );
  }

  // lockAndGetExcessSource
  async lockLiveAdvanceSource(trx: Knex.Transaction, orgUID: number, paymentUID: number): Promise<Row | null> {
    return (await trx(PAYMENTS).select("PaymentUID", "ExcessAmount").where({ PaymentUID: paymentUID, OrgUID: orgUID, IsDeleted: 0 }).forUpdate().first()) ?? null;
  }

  async insertPayment(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx(PAYMENTS).insert(row);
    return Number(id);
  }

  async updatePayment(trx: Knex.Transaction, orgUID: number, paymentUID: number, data: Row, liveOnly = false): Promise<void> {
    const query = trx(PAYMENTS).where({ PaymentUID: paymentUID, OrgUID: orgUID });
    if (liveOnly) query.where("IsDeleted", 0);
    await query.update(data);
  }

  // getPaymentRow — a live payment with its link fields
  async paymentRow(trx: Knex.Transaction, orgUID: number, paymentUID: number): Promise<Row | null> {
    return (
      (await trx(PAYMENTS)
        .select(
          "PaymentUID",
          "TransUID",
          "ModuleUID",
          "SourceType",
          "Amount",
          "PartyType",
          "PartyUID",
          "IsOnAccount",
          "OnAccountAppliedTransUID",
          "OnAccountSourcePaymentUID",
          "IsTransferredToCreditNote",
          "IsCancelled",
          "IsExcessApplied",
          "ExcessSourcePaymentUID",
          "ExcessAmount"
        )
        .where({ PaymentUID: paymentUID, OrgUID: orgUID, IsDeleted: 0 })
        .first()) ?? null
    );
  }

  // getTransactionBasicInfo
  async transaction(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<Row | null> {
    return (await trx(TRANSACTIONS).select("TransUID", "ModuleUID", "NetAmount", "DocStatus", "UniqueNumber").where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 }).first()) ?? null;
  }

  // getSumPaidForTransaction — live payments of the transaction (expense / income payments excluded)
  async paidTotal(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<number> {
    const row = await trx(`${PAYMENTS} as P`)
      .sum("P.Amount as TotalPaid")
      .where({ "P.TransUID": transUID, "P.OrgUID": orgUID, "P.IsDeleted": 0, "P.IsActive": 1, "P.IsCancelled": 0 })
      .whereRaw("(P.SourceType IS NULL OR P.SourceType NOT IN ('Expense', 'IndirectIncome'))")
      .first();
    return Number(row?.TotalPaid ?? 0);
  }

  // updateTransIsFullyPaid + updateTransDocStatus
  async setTransactionPaid(trx: Knex.Transaction, orgUID: number, transUID: number, data: { IsFullyPaid: number; PaidAmount: number; BalanceAmount: number; DocStatus: string }, userUID: number): Promise<void> {
    await trx(TRANSACTIONS)
      .where({ TransUID: transUID, OrgUID: orgUID })
      .update({ ...data, UpdatedBy: userUID, UpdatedOn: trx.fn.now() });
  }

  // getAppliedChildPayment — a live payment applied from this on-account credit
  async appliedChild(trx: Knex.Transaction, orgUID: number, paymentUID: number): Promise<Row | null> {
    return (
      (await trx(`${PAYMENTS} as P`)
        .select("P.PaymentUID", "T.UniqueNumber")
        .leftJoin(`${TRANSACTIONS} as T`, "T.TransUID", "P.TransUID")
        .where({ "P.OnAccountSourcePaymentUID": paymentUID, "P.OrgUID": orgUID, "P.IsCancelled": 0, "P.IsDeleted": 0 })
        .first()) ?? null
    );
  }

  // getActiveAdvanceLink — a live payment that spends this payment's advance
  async activeAdvanceLink(trx: Knex.Transaction, orgUID: number, paymentUID: number): Promise<boolean> {
    return !!(await trx(PAYMENTS).select("TransUID").where({ ExcessSourcePaymentUID: paymentUID, OrgUID: orgUID, IsDeleted: 0, IsCancelled: 0 }).first());
  }

  // getSRCreditNoteBySourceTrans — the credit note of a sales return
  async salesReturnCreditNote(trx: Knex.Transaction, orgUID: number, transUID: number): Promise<Row | null> {
    return (
      (await trx(CREDIT_NOTES).where({ SourceTransUID: transUID, SourceModuleUID: 106, OrgUID: orgUID, IsDeleted: 0, IsCancelled: 0 }).first()) ?? null
    );
  }

  // updateSRCreditNoteAmount
  async setCreditNoteAmount(trx: Knex.Transaction, orgUID: number, creditNoteUID: number, amount: number, userUID: number): Promise<void> {
    await trx(CREDIT_NOTES).where({ CreditNoteUID: creditNoteUID, OrgUID: orgUID }).update({ Amount: amount, PaymentCleared: 0, UpdatedBy: userUID });
  }

  // getCNByAppliedPayment — the credit note this payment applied
  async creditNoteAppliedBy(trx: Knex.Transaction, orgUID: number, paymentUID: number): Promise<number | null> {
    const row = await trx(CREDIT_NOTES).select("CreditNoteUID").where({ AppliedPaymentUID: paymentUID, OrgUID: orgUID, Status: "Applied", IsDeleted: 0 }).first();
    return row ? Number(row.CreditNoteUID) : null;
  }

  // The credit note returns to Pending when its applied payment is removed
  async reopenCreditNote(trx: Knex.Transaction, orgUID: number, creditNoteUID: number, userUID: number): Promise<void> {
    await trx(CREDIT_NOTES)
      .where({ CreditNoteUID: creditNoteUID, OrgUID: orgUID, IsDeleted: 0 })
      .update({ Status: "Pending", AppliedTransUID: 0, AppliedPaymentUID: 0, UpdatedBy: userUID });
  }

  // getOnAccountSourcePayment
  async onAccountSource(trx: Knex.Transaction, orgUID: number, paymentUID: number): Promise<Row | null> {
    return (await trx(PAYMENTS).select("PaymentUID", "Amount", "IsOnAccount").where({ PaymentUID: paymentUID, OrgUID: orgUID, IsDeleted: 0 }).first()) ?? null;
  }
}
