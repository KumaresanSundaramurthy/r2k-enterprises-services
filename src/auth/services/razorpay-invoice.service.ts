import { Injectable, Logger } from "@nestjs/common";
import { randomUUID, createHmac } from "crypto";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";
import { getRazorpayClient } from "../../config/razorpay";
import { SubscriptionBillingService } from "./subscription-billing.service";
import { billingFy, calcPlanEndDate } from "../../core/utils/billing-fy";

type Row = Record<string, unknown>;

@Injectable()
export class RazorpayInvoiceService {
  private readonly logger = new Logger(RazorpayInvoiceService.name);

  constructor(private readonly billingOps: SubscriptionBillingService) {}

  // ── Webhook signature verification ───────────────────────────────────────────

  /**
   * @param rawBody - raw request body bytes
   * @param signature - value of the x-razorpay-signature header
   * @returns true when the HMAC-SHA256 matches RAZORPAY_WEBHOOK_SECRET
   */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return expected === signature;
  }

  // ── DB queries (ported from Razorpay_model.php) ───────────────────────────────

  /**
   * @param token - 10-char TransToken
   * @returns transaction stub with BalanceAmount, ModuleUID, DocStatus, OrgUID, TransUID
   */
  async getTransactionStub(token: string): Promise<Row | null> {
    const row = await erpKnexRead("Transaction.TransactionsTbl")
      .select("TransUID", "OrgUID", "ModuleUID", "DocStatus", "UniqueNumber", "BalanceAmount")
      .where({ TransToken: token, IsDeleted: 0, IsActive: 1 })
      .first();
    return row ?? null;
  }

  /**
   * Combined stub + customer info for the public payment page — single query for Pay.php.
   * @param token - 10-char TransToken
   * @returns flat row: stub fields + PartyUID, PartyName, MobileNumber, EmailAddress
   */
  async getInvoiceInfoForPayPage(token: string): Promise<Row | null> {
    const row = await erpKnexRead("Transaction.TransactionsTbl as T")
      .leftJoin("Customers.CustomerTbl as C", erpKnexRead.raw("C.CustomerUID = T.PartyUID AND T.PartyType = 'C'"))
      .select(
        "T.TransUID", "T.OrgUID", "T.ModuleUID", "T.DocStatus", "T.TransType",
        "T.UniqueNumber", "T.NetAmount", "T.PaidAmount", "T.BalanceAmount",
        "T.PartyType", "T.PartyUID",
        erpKnexRead.raw("COALESCE(C.Name, '') AS PartyName"),
        erpKnexRead.raw("COALESCE(C.MobileNumber, '') AS MobileNumber"),
        erpKnexRead.raw("COALESCE(C.EmailAddress, '') AS EmailAddress")
      )
      .where({ "T.TransToken": token, "T.IsDeleted": 0, "T.IsActive": 1 })
      .first();
    return row ?? null;
  }

  /**
   * @param transUID - TransactionsTbl PK
   * @returns {PartyUID, PartyName, MobileNumber, EmailAddress}
   */
  async getInvoicePartyInfo(transUID: number): Promise<Row | null> {
    const row = await erpKnexRead("Transaction.TransactionsTbl as T")
      .leftJoin("Customers.CustomerTbl as C", erpKnexRead.raw("C.CustomerUID = T.PartyUID AND T.PartyType = 'C'"))
      .select(
        "T.PartyUID",
        erpKnexRead.raw("COALESCE(C.Name, '') AS PartyName"),
        erpKnexRead.raw("COALESCE(C.MobileNumber, '') AS MobileNumber"),
        erpKnexRead.raw("COALESCE(C.EmailAddress, '') AS EmailAddress")
      )
      .where({ "T.TransUID": transUID, "T.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  /**
   * Idempotency check — returns the existing payment row if the Razorpay payment was already recorded.
   * @param paymentId - Razorpay payment ID (pay_xxx)
   * @param orgUID
   */
  async getPaymentByRazorpayRef(paymentId: string, orgUID: number): Promise<Row | null> {
    const row = await erpKnexRead("Transaction.PaymentsTbl")
      .select("PaymentUID", "ReceiptToken")
      .where({ ReferenceNo: paymentId, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  /**
   * Idempotency check — returns a subscription order row for this Razorpay payment.
   * @param paymentId - Razorpay payment ID
   */
  async getSubscriptionOrderByPaymentId(paymentId: string): Promise<Row | null> {
    const row = await erpKnexRead("Billing.SubscriptionOrdersTbl")
      .select("SubscriptionOrderUID", "OrgUID", "Status")
      .where({ RazorpayPaymentId: paymentId })
      .first();
    return row ?? null;
  }

  /**
   * @param orgUID
   * @returns most recent non-cancelled OrgSubscriptionTbl row {OrgSubUID, Status, SectorPlanUID}
   */
  async getSubscriptionRow(orgUID: number): Promise<Row | null> {
    const row = await erpKnexRead("Billing.OrgSubscriptionTbl")
      .select("OrgSubUID", "Status", "SectorPlanUID")
      .where("OrgUID", orgUID)
      .whereNotIn("Status", ["Cancelled"])
      .orderBy("OrgSubUID", "desc")
      .first();
    return row ?? null;
  }

  /**
   * @param sectorPlanUID
   * @returns {Price, DurationDays, PlanName}
   */
  async getSubscriptionPlanDetails(sectorPlanUID: number): Promise<Row | null> {
    const row = await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select("SPT.Price", "SPT.DurationDays", "SP.PlanName")
      .where("SPT.SectorPlanUID", sectorPlanUID)
      .first();
    return row ?? null;
  }

  /**
   * Finds the most suitable online payment type UID from Global.PaymentTypesTbl.
   * Preference order: keyword match (online/upi/razorpay/…) → first non-cash → first available.
   * @param _orgUID - unused (payment types are global, not org-scoped)
   * @returns PaymentTypeUID or 0 if none found
   */
  async getOnlinePaymentTypeUID(_orgUID = 0): Promise<number> {
    const rows = await erpKnexRead("Global.PaymentTypesTbl")
      .select("PaymentTypeUID", "Name", "IsCash")
      .where({ IsDeleted: 0, IsActive: 1 })
      .orderBy("PaymentTypeUID", "asc");

    const keywords = ["online", "upi", "razorpay", "net banking", "netbanking", "neft", "imps"];
    let firstNonCash = 0;

    for (const row of rows) {
      const lower = String(row.Name ?? "").toLowerCase();
      for (const kw of keywords) {
        if (lower.includes(kw)) return Number(row.PaymentTypeUID);
      }
      if (!firstNonCash && !row.IsCash) firstNonCash = Number(row.PaymentTypeUID);
    }

    return firstNonCash || (rows.length ? Number(rows[0].PaymentTypeUID) : 0);
  }

  // ── Business logic ────────────────────────────────────────────────────────────

  /**
   * Creates a Razorpay order for the pending balance on an invoice.
   * @param token - 10-char TransToken from the invoice share link
   * @returns order details for the Razorpay checkout modal
   */
  async createInvoiceOrder(token: string): Promise<Row> {
    if (token.length !== 10) throw new Error("Invalid invoice link.");

    const keyId = process.env.RAZORPAY_KEY_ID;
    if (!keyId || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error("Online payment is not currently enabled for this business.");
    }

    const stub = await this.getTransactionStub(token);
    if (!stub) throw new Error("Invoice not found.");
    if (Number(stub.ModuleUID) !== 103) throw new Error("Online payment is only available for invoices.");
    if (["Cancelled", "Rejected", "Draft"].includes(String(stub.DocStatus))) {
      throw new Error("This invoice cannot be paid online.");
    }

    const pendingAmt = Math.max(0, Math.round(Number(stub.BalanceAmount ?? 0) * 100) / 100);
    if (pendingAmt < 1) throw new Error("This invoice is already fully paid.");

    const custInfo = await this.getInvoicePartyInfo(Number(stub.TransUID));
    const orgUID = Number(stub.OrgUID);

    const orgRow = (await erpKnexRead("Organisation.OrganisationTbl")
      .select("BrandName", "Name")
      .where("OrgUID", orgUID)
      .first()) as Row | undefined;
    const orgName = String(orgRow?.BrandName ?? orgRow?.Name ?? "Invoice Payment").replace(/[<>"&]/g, "");

    const amountPaise = Math.round(pendingAmt * 100);
    const receiptId = "r2k_" + String(stub.UniqueNumber ?? "").replace(/[^A-Za-z0-9]/g, "") + "_" + Date.now();
    const orderNotes = {
      type: "invoice",
      trans_token: token,
      invoice: String(stub.UniqueNumber ?? ""),
    };

    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({ amount: amountPaise, currency: "INR", receipt: receiptId, notes: orderNotes });

    return {
      Error: false,
      order_id: order.id,
      key_id: keyId,
      amount: amountPaise,
      currency: "INR",
      name: orgName,
      description: `Invoice ${String(stub.UniqueNumber ?? "")}`,
      prefill: {
        name: String(custInfo?.PartyName ?? ""),
        contact: String(custInfo?.MobileNumber ?? ""),
        email: String(custInfo?.EmailAddress ?? ""),
      },
      notes: orderNotes,
    };
  }

  /**
   * Verifies the Razorpay HMAC-SHA256 signature and records the invoice payment in ERP.
   * @param token - 10-char TransToken
   * @param rpOrderId - razorpay_order_id from the callback
   * @param rpPaymentId - razorpay_payment_id from the callback
   * @param rpSignature - razorpay_signature from the callback
   * @returns {Error, Message, receiptToken?}
   */
  async verifyAndRecordInvoicePayment(
    token: string,
    rpOrderId: string,
    rpPaymentId: string,
    rpSignature: string
  ): Promise<{ Error: boolean; Message: string; receiptToken?: string }> {
    if (token.length !== 10) throw new Error("Invalid invoice link.");
    if (!rpOrderId || !rpPaymentId || !rpSignature) throw new Error("Incomplete payment data. Please try again.");

    const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
    const expected = createHmac("sha256", keySecret).update(`${rpOrderId}|${rpPaymentId}`).digest("hex");
    if (expected !== rpSignature) {
      throw new Error("Payment verification failed. Please contact support if money was deducted.");
    }

    const stub = await this.getTransactionStub(token);
    if (!stub) throw new Error("Invoice not found.");
    if (Number(stub.ModuleUID) !== 103) throw new Error("Invalid document type for payment.");

    const pendingAmt = Math.max(0, Math.round(Number(stub.BalanceAmount ?? 0) * 100) / 100);
    const orgUID = Number(stub.OrgUID);

    const existing = await this.getPaymentByRazorpayRef(rpPaymentId, orgUID);
    if (existing) {
      return { Error: false, Message: "Payment already recorded.", receiptToken: String(existing.ReceiptToken ?? "") };
    }

    if (pendingAmt < 0.01) {
      return { Error: false, Message: "Invoice is already fully paid." };
    }

    const custInfo = await this.getInvoicePartyInfo(Number(stub.TransUID));
    if (!custInfo) throw new Error("Customer information could not be resolved.");

    const payTypeUID = await this.getOnlinePaymentTypeUID(orgUID);
    if (!payTypeUID) throw new Error("No online payment type is configured in Settings.");

    const receiptToken = randomUUID();

    await erpKnexWrite("Transaction.PaymentsTbl").insert({
      OrgUID: orgUID,
      BranchUID: 1,
      TransUID: Number(stub.TransUID),
      ModuleUID: 110,
      PartyType: "C",
      PartyUID: Number(custInfo.PartyUID),
      PaymentTypeUID: payTypeUID,
      Amount: pendingAmt,
      BankAccountUID: null,
      ReferenceNo: rpPaymentId,
      Notes: "Online payment via Razorpay",
      IsFullyPaid: 1,
      ExcessAmount: 0,
      AppliedToTransUID: null,
      ReceiptToken: receiptToken,
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: null,
      UpdatedBy: null,
    });

    const amtStr = pendingAmt % 1 === 0 ? String(pendingAmt) : pendingAmt.toFixed(2);
    return { Error: false, Message: `Payment of ₹${amtStr} recorded successfully.`, receiptToken };
  }

  /**
   * Routes a payment.captured webhook event to the invoice or subscription handler.
   * @param event - parsed Razorpay webhook body
   */
  async handlePaymentCaptured(event: Row): Promise<void> {
    const payload = (event.payload as Row) ?? {};
    const entity = ((payload.payment as Row)?.entity ?? {}) as Row;
    const paymentId = String(entity.id ?? "");
    const orderId = String(entity.order_id ?? "");
    const notes = (entity.notes as Record<string, string>) ?? {};

    if (!paymentId) return;

    const noteType = String(notes.type ?? "");

    if (noteType === "invoice" && notes.trans_token) {
      await this._webhookRecordInvoicePayment(notes.trans_token, paymentId);
      return;
    }

    if (noteType === "subscription" && notes.org_uid) {
      await this._webhookRecordSubscriptionPayment(Number(notes.org_uid), Number(notes.sector_plan_uid ?? 0), orderId, paymentId);
      return;
    }

    /* Unknown payment — last-resort idempotency check covers old orders created before notes were added */
    const knownOrder = await this.getSubscriptionOrderByPaymentId(paymentId);
    if (knownOrder) return;

    throw new Error(
      `Unrecognized payment captured. Manual verification needed. PaymentID: ${paymentId}, OrderID: ${orderId}`
    );
  }

  // ── Private webhook helpers ───────────────────────────────────────────────────

  /**
   * Recovers an invoice payment captured by Razorpay when the browser's verifyAndRecord never fired.
   */
  private async _webhookRecordInvoicePayment(token: string, paymentId: string): Promise<void> {
    const stub = await this.getTransactionStub(token);
    if (!stub || Number(stub.ModuleUID) !== 103) return;

    const existing = await this.getPaymentByRazorpayRef(paymentId, Number(stub.OrgUID));
    if (existing) return;

    const pendingAmt = Math.max(0, Math.round(Number(stub.BalanceAmount ?? 0) * 100) / 100);
    if (pendingAmt < 0.01) return;

    const custInfo = await this.getInvoicePartyInfo(Number(stub.TransUID));
    if (!custInfo) throw new Error(`Customer not found. TransUID=${stub.TransUID}`);

    const payTypeUID = await this.getOnlinePaymentTypeUID(Number(stub.OrgUID));
    if (!payTypeUID) throw new Error(`No online payment type configured. OrgUID=${stub.OrgUID}`);

    await erpKnexWrite("Transaction.PaymentsTbl").insert({
      OrgUID: Number(stub.OrgUID),
      BranchUID: 1,
      TransUID: Number(stub.TransUID),
      ModuleUID: 110,
      PartyType: "C",
      PartyUID: Number(custInfo.PartyUID),
      PaymentTypeUID: payTypeUID,
      Amount: pendingAmt,
      BankAccountUID: null,
      ReferenceNo: paymentId,
      Notes: "Online payment via Razorpay (webhook recovery)",
      IsFullyPaid: 1,
      ExcessAmount: 0,
      AppliedToTransUID: null,
      ReceiptToken: randomUUID(),
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: null,
      UpdatedBy: null,
    });
  }

  /**
   * Recovers a subscription payment captured by Razorpay when the browser's confirmPayment never fired.
   * Mirrors per-flow logic in Signuppayment::confirmPayment() / Subscriptionrenew::confirmPayment().
   */
  private async _webhookRecordSubscriptionPayment(orgUID: number, sectorPlanUID: number, orderId: string, paymentId: string): Promise<void> {
    const existing = await this.getSubscriptionOrderByPaymentId(paymentId);
    if (existing) return;

    if (orgUID <= 0 || sectorPlanUID <= 0) throw new Error("Invalid orgUID or sectorPlanUID in webhook notes.");

    const subRow = await this.getSubscriptionRow(orgUID);
    if (!subRow) throw new Error(`Subscription row not found. OrgUID=${orgUID}`);

    const flow =
      subRow.Status === "PendingPayment" ? "signup"
      : subRow.Status === "Expired" ? "renewal"
      : subRow.Status === "Active" ? "upgrade"
      : null;

    if (!flow) throw new Error(`Unexpected subscription status: ${subRow.Status} OrgUID=${orgUID}`);

    const plan = await this.getSubscriptionPlanDetails(sectorPlanUID);
    if (!plan) throw new Error(`Plan not found. SectorPlanUID=${sectorPlanUID}`);

    await this.billingOps.applyPlanMenuFilter(orgUID, sectorPlanUID);

    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    const endDate = calcPlanEndDate(Number(plan.DurationDays));
    const orgSubUID = Number(subRow.OrgSubUID);
    const fy = billingFy("long");
    const price = Number(plan.Price);

    if (flow === "signup") {
      await erpKnexWrite("Billing.OrgSubscriptionTbl").where("OrgSubUID", orgSubUID).update({ Status: "Active" });
      await erpKnexWrite("Billing.SubscriptionOrdersTbl")
        .where({ OrgUID: orgUID, Status: "Pending" })
        .update({ Status: "Paid", IsPaid: 1, PaidOn: now, PaymentMode: "Razorpay", RazorpayOrderId: orderId, RazorpayPaymentId: paymentId });

    } else if (flow === "renewal") {
      await erpKnexWrite("Billing.OrgSubscriptionTbl")
        .where("OrgSubUID", orgSubUID)
        .update({ SectorPlanUID: sectorPlanUID, Status: "Active", StartDate: now, EndDate: endDate });

      await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
        OrgUID: orgUID, SectorPlanUID: sectorPlanUID, OrgSubUID: orgSubUID, RenewalType: "Renewal",
        DueDate: endDate, Amount: price, DiscountAmount: 0, TaxAmount: 0, NetAmount: price,
        FinancialYear: fy, Status: "Paid", IsPaid: 1, PaidOn: now,
        PaymentMode: "Razorpay", RazorpayOrderId: orderId, RazorpayPaymentId: paymentId, CreatedBy: null,
      });

    } else {
      await erpKnexWrite("Billing.SubscriptionOrdersTbl").insert({
        OrgUID: orgUID, SectorPlanUID: sectorPlanUID, OrgSubUID: orgSubUID, RenewalType: "Upgrade",
        DueDate: now, Amount: price, DiscountAmount: 0, TaxAmount: 0, NetAmount: price,
        FinancialYear: fy, Status: "Paid", IsPaid: 1, PaidOn: now,
        PaymentMode: "Razorpay", RazorpayOrderId: orderId, RazorpayPaymentId: paymentId, CreatedBy: null,
      });
    }
  }
}
