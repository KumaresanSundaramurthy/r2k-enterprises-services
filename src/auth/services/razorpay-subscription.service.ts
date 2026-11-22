import { Injectable } from "@nestjs/common";
import crypto from "crypto";
import { erpKnexRead } from "../../config/erp-knex";
import { getRazorpayClient } from "../../config/razorpay";

export interface SubscriptionOrderResult {
  order_id: string;
  key_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; email: string };
}

export interface FetchedPaymentDetails {
  paymentMode: string;
  bankRrn: string;
}

@Injectable()
export class RazorpaySubscriptionService {
  async createOrder(orgUID: number, sectorPlanUID: number, orgName: string, orgEmail: string): Promise<SubscriptionOrderResult> {
    const plan = (await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select("SPT.Price", "SP.PlanName", "SP.BillingCycle")
      .where({ "SPT.SectorPlanUID": sectorPlanUID, "SPT.IsActive": 1 })
      .first()) as { Price: string; PlanName: string; BillingCycle: string } | undefined;

    if (!plan) throw new Error("Plan not found.");

    const amountPaise = Math.round(Number(plan.Price) * 100);
    if (amountPaise < 100) throw new Error("Plan amount too low for online payment.");

    const keyId = process.env.RAZORPAY_KEY_ID;
    if (!keyId || !process.env.RAZORPAY_KEY_SECRET) throw new Error("Online payment is not currently enabled. Please contact support.");

    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: `sub_${orgUID}_${sectorPlanUID}_${Date.now()}`,
      notes: { type: "subscription", org_uid: String(orgUID), sector_plan_uid: String(sectorPlanUID) },
    });

    return {
      order_id: order.id,
      key_id: keyId,
      amount: amountPaise,
      currency: "INR",
      name: orgName,
      description: `${plan.PlanName} — ${plan.BillingCycle}`,
      prefill: { name: orgName, email: orgEmail },
    };
  }

  verifySignature(orderId: string, paymentId: string, signature: string): boolean {
    const keySecret = process.env.RAZORPAY_KEY_SECRET ?? "";
    const expected = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");
    return expected === signature;
  }

  async fetchPaymentDetails(paymentId: string): Promise<FetchedPaymentDetails> {
    const razorpay = getRazorpayClient();
    const p = (await razorpay.payments.fetch(paymentId)) as unknown as Record<string, unknown>;
    const acq = (p.acquirer_data ?? {}) as Record<string, unknown>;
    return {
      paymentMode: this.parsePaymentMode(p),
      bankRrn: String(acq.rrn ?? acq.bank_transaction_id ?? ""),
    };
  }

  private parsePaymentMode(p: Record<string, unknown>): string {
    const method = String(p.method ?? "");
    const card = (p.card ?? {}) as Record<string, unknown>;
    switch (method) {
      case "upi":        return "UPI" + (p.vpa ? ` - ${p.vpa}` : "");
      case "card":       return "Card - " + `${card.network ?? ""} ${String(card.type ?? "").replace(/^\w/, (c) => c.toUpperCase())}`.trim();
      case "netbanking": return "Netbanking" + (p.bank ? ` - ${String(p.bank).toUpperCase()}` : "");
      case "wallet":     return "Wallet - " + String(p.wallet ?? "").replace(/^\w/, (c) => c.toUpperCase());
      case "emi":        return "EMI";
      default:           return "Razorpay";
    }
  }
}
