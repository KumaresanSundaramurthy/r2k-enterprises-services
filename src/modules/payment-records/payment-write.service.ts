import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { phpRound, smartDecimal, todayDate } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { AccountLedgerService } from "../../libraries/account-ledger/account-ledger.service";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { CustomerBalanceService } from "../../libraries/customer-balance/customer-balance.service";
import { JournalService } from "../../libraries/journal/journal.service";
import { CustomerCacheService } from "../customers/customer-cache.service";
import { PaymentWritesRepository } from "./payment-writes.repository";

type Form = Record<string, unknown>;

// Payments page module (Payment In); a payment without a module of its own is recorded under it
export const PAYMENTS_MODULE = 110;
const SALES_RETURN_MODULE = 106;
const round = (value: unknown) => phpRound(Number(value) || 0, AMOUNT_DECIMALS);
const amountOf = (form: Form, key: string) => Number(postValue(form, key, 0)) || 0;

const CREDIT_NOTE_MESSAGE =
  "This payment has been converted to a Credit Note. To remove it, delete the linked Credit Note from the Credit Notes tab — " +
  "that will automatically delete this payment and revert the customer balance.";
const ON_ACCOUNT_MESSAGE =
  "This payment is held as an on-account credit for the customer (from a cancelled invoice). " +
  "It cannot be cancelled or deleted directly — apply it to a new invoice to use the credit.";

/**
 * Recording and removing payments (CI3 Payments::addPayment / deletePayment). A payment may also spend a
 * customer's unused advance (ExcessAmount of an earlier payment) or on-account credit; each use is its own
 * memo row, and removing one gives the credit back.
 */
@Injectable()
export class PaymentWriteService {
  private readonly logger = new Logger(PaymentWriteService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly repo: PaymentWritesRepository,
    private readonly journal: JournalService,
    private readonly ledgers: AccountLedgerService,
    private readonly customerBalance: CustomerBalanceService,
    private readonly customerCache: CustomerCacheService,
    private readonly orgSettings: OrgSettingsService,
    private readonly audit: AuditLogService
  ) {}

  /**
   * addPayment — a cash payment and / or advance and on-account credit applied to a transaction. The
   * transaction row is locked first, so a second payment for the same bill waits and then sees the first.
   */
  async add(ctx: WriteContext, form: Form) {
    const { orgUID, userUID } = ctx;
    const transUID = postInt(form, "TransUID");
    const moduleUID = postInt(form, "ModuleUID") || PAYMENTS_MODULE;
    const paymentTypeUID = postInt(form, "PaymentTypeUID");
    const amount = amountOf(form, "Amount");
    const partyType = postString(form, "PartyType") || "C";
    const partyUID = postInt(form, "PartyUID");
    const bankAccountUID = postInt(form, "BankAccountUID") || null;
    const referenceNo = postString(form, "ReferenceNo") || null;
    const isFullyPaid = postInt(form, "IsFullyPaid") === 1 ? 1 : 0;
    let advanceAmount = amountOf(form, "AdvanceAmount");
    const advanceSourceUID = postInt(form, "ExcessSourcePaymentUID");
    let onAccountAmount = amountOf(form, "OnAccountAmount");
    const onAccountSourceUID = postInt(form, "OnAccountSourcePaymentUID");

    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    if (amount <= 0 && advanceAmount <= 0 && onAccountAmount <= 0) throw new CiValidationError("Payment amount must be greater than 0.");
    if (amount > 0 && paymentTypeUID <= 0) throw new CiValidationError("Please select a payment type.");
    if (advanceAmount > 0 && advanceSourceUID <= 0) throw new CiValidationError("Invalid advance payment source.");
    if (onAccountAmount > 0 && onAccountSourceUID <= 0) throw new CiValidationError("Invalid on-account payment source.");

    const common = { OrgUID: orgUID, BranchUID: ctx.branchUID ?? 1, TransUID: transUID, ModuleUID: moduleUID, PartyType: partyType, PartyUID: partyUID, PaymentTypeUID: paymentTypeUID };
    const audited = { IsActive: 1, IsDeleted: 0, CreatedBy: userUID, UpdatedBy: userUID };

    const created = await this.db.write.transaction(async (trx) => {
      const bill = await this.repo.lockTransaction(trx, orgUID, transUID);
      if (!bill) throw new CiValidationError("Invoice not found.");
      if (Number(bill.IsDeleted) === 1) throw new CiValidationError("This invoice has been deleted and cannot accept payments.");
      if (["Cancelled", "Rejected"].includes(String(bill.DocStatus))) throw new CiValidationError(`This invoice is ${bill.DocStatus} and cannot accept payments.`);
      const net = Number(bill.NetAmount ?? 0);
      const paid = Number(bill.PaidAmount ?? 0);
      if (net > 0) {
        if (paid >= net) throw new CiValidationError("This invoice has already been fully paid. No further payment is needed.", { ErrorCode: 1002 });
        if (round(paid + amount) > round(net)) {
          const remaining = Math.max(0, round(net - paid));
          throw new CiValidationError(
            `Payment exceeds the invoice balance. Remaining: ${smartDecimal(remaining)}. Another payment may have been recorded simultaneously — please refresh and try again.`
          );
        }
      }
      const excessAmount = net > 0 ? Math.max(0, amount - net) : 0;

      let onAccountSource = null;
      if (onAccountAmount > 0) {
        onAccountSource = await this.repo.lockOnAccountSource(trx, orgUID, onAccountSourceUID, partyUID);
        if (!onAccountSource) throw new CiValidationError("On-account payment source not found.", { ErrorCode: 1001 });
        const available = round(onAccountSource.Amount);
        if (available <= 0) throw new CiValidationError("No on-account balance available — it may have been used by another user. Please refresh and try again.", { ErrorCode: 1001 });
        onAccountAmount = round(onAccountAmount);
        if (onAccountAmount > available) throw new CiValidationError(`On-account amount (${smartDecimal(onAccountAmount)}) exceeds available balance (${smartDecimal(available)}).`);
      }

      let advanceSource = null;
      if (advanceAmount > 0) {
        advanceSource = await this.repo.lockAdvanceSource(trx, orgUID, advanceSourceUID, partyUID, partyType);
        if (!advanceSource) throw new CiValidationError("Advance payment source not found.");
        if (Number(advanceSource.IsDeleted) === 1) throw new CiValidationError("The advance payment source has been deleted.");
        if (Number(advanceSource.IsCancelled) === 1) throw new CiValidationError("The advance payment source has been cancelled.");
        const available = round(advanceSource.ExcessAmount);
        if (available <= 0) throw new CiValidationError("No advance balance available — it may have been used by another user. Please refresh and try again.", { ErrorCode: 1001 });
        advanceAmount = round(advanceAmount);
        if (advanceAmount > available) throw new CiValidationError(`Advance amount (${smartDecimal(advanceAmount)}) exceeds available balance (${smartDecimal(available)}).`);
      }

      let paymentUID: number | null = null;
      if (amount > 0) {
        paymentUID = await this.repo.insertPayment(trx, {
          ...common,
          Amount: amount,
          BankAccountUID: bankAccountUID,
          ReferenceNo: referenceNo,
          Notes: postString(form, "Notes") || null,
          IsFullyPaid: advanceAmount > 0 ? 0 : isFullyPaid,
          ExcessAmount: excessAmount,
          AppliedToTransUID: null,
          IsExcessApplied: 0,
          ExcessSourcePaymentUID: null,
          ReceiptToken: randomUUID(),
          ...audited,
        });
      }

      // The advance used is a memo row (left out of the customer balance) and comes off the source's ExcessAmount
      let advanceUID: number | null = null;
      if (advanceSource) {
        advanceUID = await this.repo.insertPayment(trx, {
          ...common,
          Amount: advanceAmount,
          BankAccountUID: bankAccountUID,
          ReferenceNo: referenceNo,
          Notes: `Advance credit from Payment #${advanceSourceUID}`,
          IsFullyPaid: isFullyPaid,
          ExcessAmount: 0,
          AppliedToTransUID: null,
          IsExcessApplied: 1,
          ExcessSourcePaymentUID: advanceSourceUID,
          ReceiptToken: randomUUID(),
          ...audited,
        });
        await this.repo.updatePayment(trx, orgUID, advanceSourceUID, { ExcessAmount: round(Number(advanceSource.ExcessAmount) - advanceAmount), UpdatedBy: userUID });
      }

      let onAccountUID: number | null = null;
      if (onAccountSource) {
        onAccountUID = await this.repo.insertPayment(trx, {
          ...common,
          Amount: onAccountAmount,
          Notes: `On-account credit from Payment #${onAccountSourceUID}`,
          IsFullyPaid: isFullyPaid,
          ExcessAmount: 0,
          IsExcessApplied: 0,
          OnAccountSourcePaymentUID: onAccountSourceUID,
          ReceiptToken: randomUUID(),
          ...audited,
        });
        await this.repo.updatePayment(trx, orgUID, onAccountSourceUID, { Amount: round(Number(onAccountSource.Amount) - onAccountAmount), UpdatedBy: userUID });
      }
      return { paymentUID, advanceUID, onAccountUID };
    });

    // The bank / cash book gets the real money only (not the advance or on-account memo rows)
    if (amount > 0 && created.paymentUID) {
      const received = partyType === "C";
      await this.journal.writeBankLedgerEntry({
        orgUID,
        bankAccountUID,
        entryType: received ? "CR" : "DR",
        amount,
        sourceType: "Payment",
        sourceUID: created.paymentUID,
        moduleUID,
        referenceNo,
        narration: received ? `Payment received from customer — #${created.paymentUID}` : `Payment made to vendor — #${created.paymentUID}`,
        entryDate: todayDate(),
        userUID,
      });
    }

    await this.audit.log(ctx, {
      action: "ADD_PAYMENT",
      entityType: "Payment",
      entityUID: created.paymentUID ?? created.advanceUID ?? 0,
      entityRef: "",
      details: { TransUID: transUID, Amount: amount, AdvanceAmount: advanceAmount, OnAccountAmount: onAccountAmount },
      summary:
        `Recorded payment for transaction #${transUID}` +
        (advanceAmount > 0 ? ` (includes ₹${advanceAmount} advance from Payment #${advanceSourceUID})` : "") +
        (onAccountAmount > 0 ? ` (includes ₹${onAccountAmount} on-account from Payment #${onAccountSourceUID})` : ""),
      module: "Payments",
      category: "PAYMENT",
    });
    return {
      Message: "Payment recorded successfully.",
      PaymentUID: created.paymentUID,
      AdvanceUID: created.advanceUID,
      AdvanceApplied: advanceAmount > 0,
      OnAccountUID: created.onAccountUID,
      OnAccountApplied: onAccountAmount > 0,
    };
  }

  /**
   * deletePayment — Action = cancel (IsCancelled) or delete (IsDeleted). Refused while the payment's credit is
   * in use elsewhere. Gives back an advance / on-account credit it used, reopens a credit note it applied,
   * restores a sales-return credit note, and recomputes the transaction's paid amount and status.
   */
  async remove(ctx: WriteContext, form: Form) {
    const { orgUID, userUID } = ctx;
    const paymentUID = postInt(form, "PaymentUID");
    const action = postString(form, "Action") === "cancel" ? "cancel" : "delete";
    if (paymentUID <= 0) throw new CiValidationError("Invalid payment record.");

    const outcome = await this.db.write.transaction(async (trx) => {
      const payment = await this.repo.paymentRow(trx, orgUID, paymentUID);
      if (!payment) throw new CiValidationError("Payment record not found or already deleted.");

      const appliedTransUID = Number(payment.OnAccountAppliedTransUID ?? 0);
      if (appliedTransUID > 0 && Number(payment.IsOnAccount ?? 1) === 0) {
        const linked = await this.repo.transaction(trx, orgUID, appliedTransUID);
        if (linked && !["Cancelled", "Rejected"].includes(String(linked.DocStatus))) {
          throw new CiValidationError(
            `This payment is adjusted against Invoice ${linked.UniqueNumber || `#${appliedTransUID}`}. You cannot delete this payment until that invoice is fully cancelled.`
          );
        }
      }
      const child = await this.repo.appliedChild(trx, orgUID, paymentUID);
      if (child) {
        throw new CiValidationError(`This On Account payment has been applied to Invoice ${child.UniqueNumber || `#${child.PaymentUID}`}. Cancel that payment first before deleting this record.`);
      }
      if (Number(payment.IsExcessApplied ?? 0) === 0 && Number(payment.ExcessAmount ?? 0) === 0 && (await this.repo.activeAdvanceLink(trx, orgUID, paymentUID))) {
        throw new CiValidationError("This payment has an advance credit used in another invoice. Remove that advance entry first, then delete this payment.");
      }
      if (Number(payment.IsTransferredToCreditNote ?? 0) === 1) throw new CiValidationError(CREDIT_NOTE_MESSAGE);
      if (Number(payment.IsOnAccount ?? 0) === 1) throw new CiValidationError(ON_ACCOUNT_MESSAGE);

      // Expense / income payments are not linked to a TransactionsTbl row (their TransUID is the record's UID)
      const linkedToTransaction = !["Expense", "IndirectIncome"].includes(String(payment.SourceType ?? ""));
      const transUID = linkedToTransaction ? Number(payment.TransUID ?? 0) : 0;
      const salesReturnNote = transUID > 0 && Number(payment.ModuleUID) === SALES_RETURN_MODULE ? await this.repo.salesReturnCreditNote(trx, orgUID, transUID) : null;
      if (salesReturnNote?.Status === "Applied") {
        throw new CiValidationError("This credit note has been applied to an invoice. Please reverse the credit allocation before deleting this payment.");
      }

      const locked = await this.repo.lockPayment(trx, orgUID, paymentUID);
      if (!locked) throw new CiValidationError("Payment record not found.");
      if (Number(locked.IsDeleted) === 1) throw new CiValidationError("This payment has already been deleted by another user.");
      if (Number(locked.IsCancelled) === 1) throw new CiValidationError("This payment has already been cancelled by another user.");
      if (Number(locked.IsTransferredToCreditNote) === 1) throw new CiValidationError(CREDIT_NOTE_MESSAGE);
      if (Number(locked.IsOnAccount) === 1) throw new CiValidationError(ON_ACCOUNT_MESSAGE);

      const amount = Number(payment.Amount);
      const paidBefore = transUID > 0 ? await this.repo.paidTotal(trx, orgUID, transUID) : 0;

      // An advance memo row gives its amount back to the source payment's ExcessAmount
      if (Number(locked.IsExcessApplied) === 1 && Number(payment.ExcessSourcePaymentUID) > 0) {
        const source = await this.repo.lockLiveAdvanceSource(trx, orgUID, Number(payment.ExcessSourcePaymentUID));
        if (source) await this.repo.updatePayment(trx, orgUID, Number(source.PaymentUID), { ExcessAmount: round(Number(source.ExcessAmount) + amount), UpdatedBy: userUID });
      }

      const flags = action === "cancel" ? { IsCancelled: 1 } : { IsDeleted: 1 };
      await this.repo.updatePayment(trx, orgUID, paymentUID, { ...flags, IsActive: 0, UpdatedBy: userUID }, true);

      let totals: Record<string, unknown> = {};
      if (transUID > 0) {
        const trans = await this.repo.transaction(trx, orgUID, transUID);
        if (trans) {
          const paid = Math.max(0, round(paidBefore - amount));
          const net = Number(trans.NetAmount);
          const balance = Math.max(0, round(net - paid));
          const fullyPaid = net > 0 && balance <= 0 ? 1 : 0;
          const status = paid <= 0 ? (Number(trans.ModuleUID) === SALES_RETURN_MODULE ? "Approved" : "Issued") : fullyPaid ? "Paid" : "Partial";
          await this.repo.setTransactionPaid(trx, orgUID, transUID, { IsFullyPaid: fullyPaid, PaidAmount: paid, BalanceAmount: balance, DocStatus: status }, userUID);
          totals = { NewPaidAmount: paid, NewBalanceAmount: balance, NewStatus: status };
        }
      }
      if (salesReturnNote?.Status === "Pending") {
        await this.repo.setCreditNoteAmount(trx, orgUID, Number(salesReturnNote.CreditNoteUID), round(Number(salesReturnNote.Amount) + amount), userUID);
      }
      // A payment made from an on-account credit gives the amount back to that credit
      const onAccountSourceUID = Number(payment.OnAccountSourcePaymentUID ?? 0);
      if (onAccountSourceUID > 0) {
        const source = await this.repo.onAccountSource(trx, orgUID, onAccountSourceUID);
        if (source) {
          await this.repo.updatePayment(trx, orgUID, onAccountSourceUID, { Amount: round(Number(source.Amount) + amount), IsOnAccount: 1, OnAccountAppliedTransUID: null, UpdatedBy: userUID });
        }
      }
      const appliedCreditNote = await this.repo.creditNoteAppliedBy(trx, orgUID, paymentUID);
      if (appliedCreditNote) await this.repo.reopenCreditNote(trx, orgUID, appliedCreditNote, userUID);

      return { payment, transUID, totals, appliedCreditNote };
    });

    const { payment, transUID, totals, appliedCreditNote } = outcome;
    const customerUID = payment.PartyType === "C" ? Number(payment.PartyUID ?? 0) : 0;
    let balance: Record<string, unknown> = {};
    if (customerUID > 0) {
      // Real customer money only: not advance / on-account memo rows or credit-note adjustments
      if (transUID > 0 && Number(payment.IsExcessApplied ?? 0) === 0 && Number(payment.OnAccountSourcePaymentUID ?? 0) === 0 && !appliedCreditNote) {
        try {
          await this.db.write.transaction((trx) => this.ledgers.applyBalanceEntry(trx, ctx, "Customer", customerUID, Number(payment.Amount), "Debit", transUID));
        } catch (err) {
          this.logger.warn(`Customer ledger entry for payment ${paymentUID} failed: ${(err as Error).message}`);
        }
      }
      try {
        const result = await this.customerBalance.recalcAndSync(orgUID, customerUID, userUID);
        if (result) balance = { CustomerBalance: result.balance, CustomerBalanceType: result.type };
        await this.customerCache.refresh(orgUID, (await this.orgSettings.get(orgUID)).OrgToken, customerUID);
      } catch (err) {
        this.logger.warn(`Customer balance refresh for payment ${paymentUID} failed: ${(err as Error).message}`);
      }
    }

    await this.audit.log(ctx, {
      action: action === "cancel" ? "CANCEL_PAYMENT" : "DELETE_PAYMENT",
      entityType: "Payment",
      entityUID: paymentUID,
      entityRef: "",
      details: { TransUID: Number(payment.TransUID ?? 0) },
      summary: `${action === "cancel" ? "Cancelled" : "Deleted"} payment #${paymentUID}`,
      module: "Payments",
      category: "PAYMENT",
    });
    return { Message: action === "cancel" ? "Payment cancelled." : "Payment deleted.", ...totals, ...balance };
  }
}
