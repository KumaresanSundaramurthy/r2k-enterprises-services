import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { monthEndDate, monthStartDate } from "../../core/utils/financial-year";
import { parseDateTime, phpRound, toInt } from "../../common/utils/php-compat";
import { CustomerBalanceService } from "../../libraries/customer-balance/customer-balance.service";
import { CustomerProfileRepository } from "./customer-profile.repository";
import { CustomersRepository, Row } from "./customers.repository";

export type ProfileTab = "overview" | "transactions" | "statement" | "notes";

// Sections of the transactions tab (CI3 getCustomerProfileTab, 'transactions')
const TRANSACTION_SECTIONS = [
  { uid: 103, label: "Invoices", icon: "bx-receipt" },
  { uid: 102, label: "Sales Orders", icon: "bx-cart-alt" },
  { uid: 101, label: "Quotations", icon: "bx-file-blank" },
  { uid: 112, label: "Delivery Challans", icon: "bx-package" },
  { uid: 106, label: "Sales Returns", icon: "bx-undo" },
  { uid: 113, label: "Proforma Invoices", icon: "bx-copy-alt" },
];
const RECENT_PER_SECTION = 5;
const DAY_MS = 86400 * 1000;
const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Customer profile modal (CI3 getCustomerProfileTab / getCustomerStatementTab). CI3 returned each tab
 * as rendered HTML; here each tab returns the same values as data and the CI3 JS renders them.
 */
@Injectable()
export class CustomerProfileService {
  constructor(
    private readonly customers: CustomersRepository,
    private readonly profile: CustomerProfileRepository,
    private readonly customerBalance: CustomerBalanceService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  async getTab(orgUID: number, customerUID: number, tab: string, langCode: string) {
    const customer = await this.requireCustomer(orgUID, customerUID, "Invalid customer ID.", langCode);
    const name = tab.toLowerCase().replace(/[^a-z]/g, "") as ProfileTab;
    switch (name) {
      case "overview":
        return { Tab: name, Data: await this.overview(orgUID, customerUID, customer, langCode) };
      case "transactions":
        return { Tab: name, Data: { TxData: await this.transactions(orgUID, customerUID) } };
      case "statement":
        return { Tab: name, Data: await this.statementData(orgUID, customerUID, customer, monthStartDate(0), monthEndDate(0)) };
      case "notes":
        return { Tab: name, Data: { Notes: await this.profile.notes(orgUID, customerUID) } };
      default:
        throw new CiValidationError("Unknown tab.");
    }
  }

  // getCustomerStatementTab — the statement for a custom date range (defaults to the current month)
  async getStatement(orgUID: number, customerUID: number, fromDate: string | undefined, toDate: string | undefined, langCode: string) {
    const from = fromDate || monthStartDate(0);
    const to = toDate || monthEndDate(0);
    if (!DATE_YMD.test(from) || !DATE_YMD.test(to)) throw new CiValidationError("Dates must be in YYYY-MM-DD format.");
    const customer = await this.requireCustomer(orgUID, customerUID, "Invalid customer.", langCode);
    return { Data: await this.statementData(orgUID, customerUID, customer, from, to) };
  }

  private async overview(orgUID: number, customerUID: number, customer: Row, langCode: string) {
    const [addresses, summary, totalReceived, monthlySales, groupMembership, openingBal, cogs] = await Promise.all([
      this.customers.findAddresses(customerUID, langCode),
      this.profile.financialSummary(orgUID, customerUID),
      this.customerBalance.totalReceived(orgUID, customerUID),
      this.profile.monthlySales(orgUID, customerUID),
      this.customers.findGroupMembership(orgUID, customerUID),
      this.customers.findOpeningBalance(orgUID, customerUID),
      this.profile.costOfGoodsSold(orgUID, customerUID),
    ]);

    const totalInvoiced = Number(summary?.TotalInvoiced ?? 0);
    const totalCollected = Number(summary?.TotalCollected ?? 0);
    const overdueCount = toInt(summary?.OverdueCount);
    const lastTxDate = summary?.LastTxDate ?? null;
    const lastTx = parseDateTime(lastTxDate);
    const collectionRate = totalInvoiced > 0 ? phpRound((totalCollected / totalInvoiced) * 100, 1) : 100;
    const health =
      collectionRate >= 90 && overdueCount === 0
        ? { HealthScore: "Good Payer", HealthColor: "success" }
        : overdueCount >= 3 || collectionRate < 50
          ? { HealthScore: "At Risk", HealthColor: "danger" }
          : { HealthScore: "Slow Payer", HealthColor: "warning" };
    const profit = totalInvoiced - cogs;

    return {
      Cust: customer,
      BillingAddr: addresses.find((address) => address.AddressType === "Billing") ?? null,
      ShippingAddr: addresses.find((address) => address.AddressType === "Shipping") ?? null,
      TotalInvoiced: totalInvoiced,
      TotalReceived: totalReceived,
      TotalReturned: Number(summary?.TotalReturned ?? 0),
      // Stored closing balance (CI3 read a column its query never selected, so it always showed 0)
      ClosingBalance: openingBal ? Number(openingBal.PendingBalance ?? 0) : 0,
      ClosingBalType: openingBal?.PendingBalType ?? "Debit",
      MonthlySales: monthlySales,
      GroupMembership: groupMembership,
      OpeningBal: openingBal,
      HealthData: {
        CollectionRate: collectionRate,
        OverdueCount: overdueCount,
        ...health,
        LastTxDate: lastTxDate,
        DaysSinceLastTx: lastTx ? Math.floor((Date.now() - lastTx.getTime()) / DAY_MS) : null,
      },
      Ageing: {
        Bucket_0_30: Number(summary?.Bucket_0_30 ?? 0),
        Bucket_31_60: Number(summary?.Bucket_31_60 ?? 0),
        Bucket_61_90: Number(summary?.Bucket_61_90 ?? 0),
        Bucket_90Plus: Number(summary?.Bucket_90Plus ?? 0),
      },
      Profitability: {
        Revenue: totalInvoiced,
        COGS: cogs,
        Profit: profit,
        Margin: totalInvoiced > 0 ? phpRound((profit / totalInvoiced) * 100, 1) : 0,
      },
    };
  }

  private async transactions(orgUID: number, customerUID: number) {
    return Promise.all(
      TRANSACTION_SECTIONS.map(async (section) => ({
        module: section,
        rows: await this.profile.recentTransactions(orgUID, customerUID, section.uid, RECENT_PER_SECTION),
      }))
    );
  }

  private async statementData(orgUID: number, customerUID: number, customer: Row, fromDate: string, toDate: string) {
    const [statement, openingBal, orgInfo] = await Promise.all([
      this.profile.statement(orgUID, customerUID, fromDate, toDate),
      this.customers.findOpeningBalance(orgUID, customerUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    return { Cust: customer, Statement: statement, OpeningBal: openingBal, FromDate: fromDate, ToDate: toDate, OrgInfo: orgInfo };
  }

  private async requireCustomer(orgUID: number, customerUID: number, invalidMessage: string, langCode: string): Promise<Row> {
    if (!Number.isInteger(customerUID) || customerUID <= 0) throw new CiValidationError(invalidMessage);
    const customer = await this.customers.findDetail(orgUID, customerUID, langCode);
    if (!customer) throw new CiValidationError("Customer not found.");
    return customer;
  }
}
