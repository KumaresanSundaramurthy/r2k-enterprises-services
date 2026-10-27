import { Injectable, Logger } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { phpRound, toInt } from "../../common/utils/php-compat";
import { CacheHelperService } from "../../libraries/cache-helper/cache-helper.service";
import { CustomerBalanceService } from "../../libraries/customer-balance/customer-balance.service";
import { CustomersRepository } from "./customers.repository";

// PHP date('c'), e.g. 2026-10-26T09:15:00+00:00
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");

// Customers whose entries are built at the same time during a full sync (each entry runs 5 queries)
const SYNC_BATCH_SIZE = 5;

/**
 * Keeps the Upstash customer map up to date (CI3 Cachehelper::upsertCustomer / removeCustomer and
 * Customers::syncCustomersCache). Entries have the shape the CI3 transaction forms read.
 * Single-customer refreshes never fail a save; a full sync reports its errors.
 */
@Injectable()
export class CustomerCacheService {
  private readonly logger = new Logger(CustomerCacheService.name);

  constructor(
    private readonly customers: CustomersRepository,
    private readonly customerBalance: CustomerBalanceService,
    private readonly cacheHelper: CacheHelperService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  async refresh(orgUID: number, orgToken: string, customerUID: number): Promise<void> {
    try {
      const entry = await this.buildEntry(orgUID, customerUID);
      if (entry) await this.cacheHelper.writeCustomerEntry(orgToken, customerUID, entry);
    } catch (err) {
      this.logger.warn(`Customer cache refresh for ${customerUID} failed: ${(err as Error).message}`);
    }
  }

  // syncCustomersCache — rebuilds {org}-customers from every active customer of the organisation
  async syncAll(orgUID: number) {
    const org = await this.orgSettings.get(orgUID);
    const customerUIDs = await this.customers.findActiveUIDs(orgUID);
    if (customerUIDs.length === 0) throw new CiValidationError("No customers found.");

    const entries = new Map<number, Record<string, unknown>>();
    for (let i = 0; i < customerUIDs.length; i += SYNC_BATCH_SIZE) {
      const batch = customerUIDs.slice(i, i + SYNC_BATCH_SIZE);
      const built = await Promise.all(batch.map((uid) => this.buildEntry(orgUID, uid)));
      batch.forEach((uid, index) => {
        const entry = built[index];
        if (entry) entries.set(uid, entry);
      });
    }
    await this.cacheHelper.replaceCustomers(org.OrgToken, entries);
    return { Message: `${entries.size} customer(s) synced to cache.`, Count: entries.size };
  }

  async remove(orgToken: string, customerUID: number): Promise<void> {
    try {
      await this.cacheHelper.removeCustomerEntry(orgToken, customerUID);
    } catch (err) {
      this.logger.warn(`Customer cache remove for ${customerUID} failed: ${(err as Error).message}`);
    }
  }

  // One customer's cache entry; null when the customer is not found
  private async buildEntry(orgUID: number, customerUID: number): Promise<Record<string, unknown> | null> {
    const customer = await this.customers.findDetail(orgUID, customerUID, "en");
    if (!customer) return null;

    const [addresses, opening, onAccount, credits] = await Promise.all([
      this.customers.findAddresses(customerUID, "en"),
      this.customers.findOpeningBalance(orgUID, customerUID),
      this.customers.findOnAccountPayments(orgUID, customerUID),
      this.customerBalance.getCreditTotals(orgUID, customerUID),
    ]);

    return {
      CustomerUID: customerUID,
      Name: customer.Name ?? "",
      CompanyName: customer.CompanyName ?? "",
      ContactPerson: customer.ContactPerson ?? "",
      MobileNumber: customer.MobileNumber ?? "",
      CountryCode: customer.CountryCode ?? "",
      CountryISO2: customer.CountryISO2 ?? "",
      EmailAddress: customer.EmailAddress ?? "",
      CCEmails: customer.CCEmails ?? "",
      GSTIN: customer.GSTIN ?? "",
      PANNumber: customer.PANNumber ?? "",
      SalutationUID: toInt(customer.SalutationUID) || null,
      CustomerTypeUID: toInt(customer.CustomerTypeUID),
      GroupUID: toInt(customer.GroupUID) || null,
      DiscountPercent: Number(customer.DiscountPercent ?? 0),
      CreditPeriod: toInt(customer.CreditPeriod),
      CreditLimit: Number(customer.CreditLimit ?? 0),
      // Closing balance = current outstanding after all invoices and payments
      ClosingBalance: opening ? Number(opening.PendingBalance ?? opening.OpeningBalance) : 0,
      ClosingBalType: opening ? opening.PendingBalType ?? opening.OpeningBalType : "Debit",
      OnAccountBalance: phpRound(
        onAccount.reduce((sum, payment) => sum + Number(payment.Amount ?? 0), 0),
        4
      ),
      OnAccountRecords: onAccount.map((payment) => ({
        PaymentUID: toInt(payment.PaymentUID),
        Amount: Number(payment.Amount ?? 0),
        CreatedOn: payment.CreatedOn ?? "",
        SourceInvoiceNumber: payment.SourceInvoiceNumber ?? "—",
      })),
      AdvanceTotal: credits.AdvanceTotal,
      CreditNoteTotal: credits.CreditNoteTotal,
      Area: customer.Area ?? "",
      Tags: customer.Tags ?? "",
      Notes: customer.Notes ?? "",
      Image: customer.Image ?? "",
      Address: addresses.map((address) => ({
        AddressType: address.AddressType,
        Line1: address.Line1 ?? "",
        Line2: address.Line2 ?? "",
        Pincode: address.Pincode ?? "",
        CityText: address.CityText ?? "",
        StateText: address.StateText ?? "",
      })),
      LastUpdatedAt: isoNow(),
    };
  }
}
