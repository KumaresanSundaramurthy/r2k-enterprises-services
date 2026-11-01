import { Injectable } from "@nestjs/common";
import { MODULE_UID } from "../../core/constants";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { monthEndDate, monthStartDate } from "../../core/utils/financial-year";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { VendorBalanceService } from "../../libraries/vendor-balance/vendor-balance.service";
import { VendorGroupsRepository } from "./vendor-groups.repository";
import { VendorProfileRepository } from "./vendor-profile.repository";
import { Row, VendorsRepository } from "./vendors.repository";

export type VendorProfileTab = "overview" | "transactions" | "statement" | "notes";

// Sections of the transactions tab (CI3 getVendorProfileTab, 'transactions')
const TRANSACTION_SECTIONS = [
  { uid: MODULE_UID.Purchases, label: "Purchases", icon: "bx-package" },
  { uid: MODULE_UID.PurchaseOrders, label: "Purchase Orders", icon: "bx-cart-alt" },
  { uid: MODULE_UID.PurchaseReturns, label: "Purchase Returns", icon: "bx-undo" },
  { uid: MODULE_UID.DebitNotes, label: "Debit Notes", icon: "bx-file-blank" },
];
const RECENT_PER_SECTION = 5;
const DATE_YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Vendor profile modal (CI3 getVendorProfileTab / getVendorStatementTab). CI3 returned each tab as rendered
 * HTML; here each tab returns the same values as data and the CI3 JS renders them.
 */
@Injectable()
export class VendorProfileService {
  constructor(
    private readonly vendors: VendorsRepository,
    private readonly profile: VendorProfileRepository,
    private readonly groups: VendorGroupsRepository,
    private readonly vendorBalance: VendorBalanceService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  async getTab(orgUID: number, vendorUID: number, tab: string, langCode: string) {
    const vendor = await this.requireVendor(orgUID, vendorUID, "Invalid vendor ID.", langCode);
    const name = tab.toLowerCase().replace(/[^a-z]/g, "") as VendorProfileTab;
    switch (name) {
      case "overview":
        return { Tab: name, Data: await this.overview(orgUID, vendorUID, vendor, langCode) };
      case "transactions":
        return { Tab: name, Data: { TxData: await this.transactions(orgUID, vendorUID), VendorUID: vendorUID } };
      case "statement":
        return { Tab: name, Data: await this.statementData(orgUID, vendorUID, vendor, monthStartDate(0), monthEndDate(0)) };
      case "notes":
        return { Tab: name, Data: { Notes: await this.profile.notes(orgUID, vendorUID), VendorUID: vendorUID } };
      default:
        throw new CiValidationError("Unknown tab.");
    }
  }

  // getVendorStatementTab — the statement for a custom date range (defaults to the current month)
  async getStatement(orgUID: number, vendorUID: number, fromDate: string | undefined, toDate: string | undefined, langCode: string) {
    const from = fromDate || monthStartDate(0);
    const to = toDate || monthEndDate(0);
    if (!DATE_YMD.test(from) || !DATE_YMD.test(to)) throw new CiValidationError("Dates must be in YYYY-MM-DD format.");
    const vendor = await this.requireVendor(orgUID, vendorUID, "Invalid vendor.", langCode);
    return { Data: await this.statementData(orgUID, vendorUID, vendor, from, to) };
  }

  private async overview(orgUID: number, vendorUID: number, vendor: Row, langCode: string) {
    const [addresses, summary, totalPaid, monthlyPurchase, groupMembership, openingBal, ledger] = await Promise.all([
      this.vendors.findAddresses(vendorUID, langCode),
      this.profile.financialSummary(orgUID, vendorUID),
      this.vendorBalance.totalPaid(orgUID, vendorUID),
      this.profile.monthlyPurchases(orgUID, vendorUID),
      this.groups.findMembership(orgUID, vendorUID),
      this.vendors.findOpeningBalance(orgUID, vendorUID),
      this.vendors.findLedgerBalance(vendorUID),
    ]);
    const daysSinceLastTx = summary?.DaysSinceLastTx;
    return {
      Vend: vendor,
      BillingAddr: addresses.find((address) => address.AddressType === "Billing") ?? null,
      ShippingAddr: addresses.find((address) => address.AddressType === "Shipping") ?? null,
      TotalPurchased: Number(summary?.TotalPurchased ?? 0),
      TotalPaid: totalPaid,
      TotalReturned: Number(summary?.TotalReturned ?? 0),
      DaysSinceLastTx: daysSinceLastTx === null || daysSinceLastTx === undefined ? null : Number(daysSinceLastTx),
      // Stored closing balance, else the ledger's (CI3 read a column its query never selected, so it always showed 0)
      ClosingBalance: openingBal ? Number(openingBal.PendingBalance ?? 0) : ledger.balance,
      ClosingBalType: openingBal ? openingBal.PendingBalType ?? "Credit" : ledger.type,
      MonthlyPurchase: monthlyPurchase,
      GroupMembership: groupMembership,
      OpeningBal: openingBal,
    };
  }

  private async transactions(orgUID: number, vendorUID: number) {
    return Promise.all(
      TRANSACTION_SECTIONS.map(async (section) => ({
        module: section,
        rows: await this.profile.recentTransactions(orgUID, vendorUID, section.uid, RECENT_PER_SECTION),
      }))
    );
  }

  private async statementData(orgUID: number, vendorUID: number, vendor: Row, fromDate: string, toDate: string) {
    const [statement, openingBal, orgInfo] = await Promise.all([
      this.profile.statement(orgUID, vendorUID, fromDate, toDate),
      this.vendors.findOpeningBalance(orgUID, vendorUID),
      this.orgSettings.getHeader(orgUID),
    ]);
    return { Vend: vendor, Statement: statement, OpeningBal: openingBal, FromDate: fromDate, ToDate: toDate, VendorUID: vendorUID, OrgInfo: orgInfo };
  }

  private async requireVendor(orgUID: number, vendorUID: number, invalidMessage: string, langCode: string): Promise<Row> {
    if (!Number.isInteger(vendorUID) || vendorUID <= 0) throw new CiValidationError(invalidMessage);
    const vendor = await this.vendors.findDetail(orgUID, vendorUID, langCode);
    if (!vendor) throw new CiValidationError("Vendor not found.");
    // Image as a full CDN URL, the same as the list and the edit form
    return vendor.Image ? { ...vendor, Image: resolveCdnUrl(vendor.Image) } : vendor;
  }
}
