import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { CreditSettingsService } from "../../libraries/credit-settings/credit-settings.service";
import { currentFinancialYear, financialYearStartDate, monthStartDate } from "../../core/utils/financial-year";
import { AMOUNT_DECIMALS, BALANCE_FY_START_MONTH } from "../../core/constants";
import { phpRound } from "../../common/utils/php-compat";
import { CustomerBalanceService } from "../../libraries/customer-balance/customer-balance.service";
import { CustomerListDto, CustomerSearchListDto, SearchCustomersDto } from "./dto/customer-list.dto";
import { CustomerBalanceDto, CustomerOpeningBalanceDto } from "./dto/customer-balance.dto";
import { CustomersRepository, Row } from "./customers.repository";

// Business rules of CI3's Customers controller; data access goes through CustomersRepository.
@Injectable()
export class CustomersService {
  constructor(
    private readonly customers: CustomersRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly creditSettings: CreditSettingsService,
    private readonly customerBalance: CustomerBalanceService
  ) {}

  // getCustomersPageDetails — one page of the customer list; the CI3 JS builds the rows and pagination.
  async getPage(orgUID: number, pageNo: number, dto: CustomerListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const page = Math.max(1, pageNo);
    const result = await this.customers.listPaginated(orgUID, page, rowLimit, dto.Filter ?? {}, dto.langCode);
    return { Data: result.rows, TotalCount: result.totalCount, PageNo: page, RowLimit: rowLimit };
  }

  // searchCustomers — Select2 typeahead: { id, text } where text is "Name (Area)".
  async searchForDropdown(dto: SearchCustomersDto) {
    const term = (dto.term ?? "").trim();
    if (!term) return { Lists: [] };

    const [matches, inOtherGroups] = await Promise.all([
      this.customers.searchByTerm(dto.orgId, term, dto.langCode),
      this.customers.findCustomerUIDsInOtherGroups(dto.orgId, dto.groupUID),
    ]);
    const excluded = new Set(inOtherGroups);
    const Lists = matches
      .filter((customer) => !excluded.has(Number(customer.CustomerUID)))
      .map((customer) => ({
        id: customer.CustomerUID,
        text: customer.Area ? `${customer.Name} (${customer.Area})` : customer.Name,
      }));
    return { Lists };
  }

  // getCustomerSearchList — customer picker with closing balance and shipping address.
  async searchWithBalance(dto: CustomerSearchListDto) {
    const search = (dto.Search ?? "").trim();
    const result = await this.customers.listPaginated(
      dto.orgId,
      dto.PageNo,
      dto.RowLimit,
      search ? { SearchAllData: search } : {},
      dto.langCode
    );
    const Customers = result.rows.map((row) => this.toPickerCustomer(row));
    return { Customers, TotalCount: result.totalCount, PageNo: dto.PageNo, RowLimit: dto.RowLimit };
  }

  // getCustomerForModal — customer with bank details, billing/shipping address and attachments.
  async getDetail(orgUID: number, customerUID: number, langCode: string) {
    if (!Number.isInteger(customerUID) || customerUID <= 0) {
      throw new CiValidationError("Invalid customer ID.");
    }
    const [customer, attachments, bankDetails, addresses] = await Promise.all([
      this.customers.findDetail(orgUID, customerUID, langCode),
      this.customers.findAttachments(orgUID, customerUID),
      this.customers.findBankDetails(customerUID),
      this.customers.findAddresses(customerUID, langCode),
    ]);
    if (!customer) {
      throw new CiValidationError("Customer not found.");
    }
    return {
      Data: customer,
      BankDetails: bankDetails,
      BillingAddr: addresses.find((address) => address.AddressType === "Billing") ?? null,
      ShippingAddr: addresses.find((address) => address.AddressType === "Shipping") ?? null,
      Attachments: attachments,
    };
  }

  // getCustomerTags
  async getTags(orgUID: number) {
    return { Tags: await this.customers.findTags(orgUID) };
  }

  // getCustomerStats — header counters of the list page (CI3 index() rendered these server-side).
  async getStats(orgUID: number) {
    const org = await this.orgSettings.get(orgUID);
    const stats = await this.customers.stats(orgUID, {
      monthStart: monthStartDate(0),
      nextMonthStart: monthStartDate(1),
      lastMonthStart: monthStartDate(-1),
      fyStart: financialYearStartDate(org.FYStartMonth),
    });
    return { Data: stats };
  }

  // getCustomerTypes
  async getTypes() {
    return { Data: await this.customers.findCustomerTypes() };
  }

  // getCustomerOpeningBalance — current opening/closing row plus the snapshot for one financial year.
  async getOpeningBalance(dto: CustomerOpeningBalanceDto) {
    const customerUID = this.requireCustomerUID(dto.CustomerUID, "Invalid customer.");
    const financialYear =
      dto.FinancialYear && dto.FinancialYear > 0
        ? dto.FinancialYear
        : currentFinancialYear(BALANCE_FY_START_MONTH);
    const [current, yearRow] = await Promise.all([
      this.customers.findOpeningBalance(dto.orgId, customerUID),
      this.customers.findYearOpening(dto.orgId, customerUID, financialYear),
    ]);
    return { Data: current, YearData: yearRow, FinancialYear: financialYear };
  }

  // getCustomerBalance — live balance with its breakdown.
  async getBalance(dto: CustomerBalanceDto) {
    const customerUID = this.requireCustomerUID(dto.CustomerUID, "Invalid customer.");
    return this.customerBalance.getLiveBalance(dto.orgId, customerUID);
  }

  // getCustomerOnAccountBalance — unapplied payments and their total.
  async getOnAccountBalance(dto: CustomerBalanceDto) {
    const customerUID = this.requireCustomerUID(dto.CustomerUID, "CustomerUID is required.");
    const payments = await this.customers.findOnAccountPayments(dto.orgId, customerUID);
    const total = payments.reduce((sum, payment) => sum + Number(payment.Amount ?? 0), 0);
    return { Total: phpRound(total, AMOUNT_DECIMALS), Payments: payments };
  }

  // getNextCustomerNumber — number to pre-fill on the "new customer" form.
  async getNextNumber(orgUID: number) {
    const org = await this.orgSettings.get(orgUID);
    return { CustomerNumber: await this.creditSettings.getCustomerNextNumber(org) };
  }

  private requireCustomerUID(customerUID: number | undefined, message: string): number {
    if (!customerUID || customerUID <= 0) throw new CiValidationError(message);
    return customerUID;
  }

  private toPickerCustomer(row: Row) {
    const customer: Record<string, unknown> = {
      CustomerUID: row.CustomerUID,
      Name: row.Name,
      Area: row.Area ?? "",
      MobileNumber: row.MobileNumber ?? "",
      Balance: row.ClosingBalance ?? 0,
      BalanceType: row.ClosingBalanceType ?? "Debit",
      CountryISO2: row.CountryISO2 ?? "IN",
    };
    if (row.ShipLine1 || row.ShipCity || row.ShipState) {
      customer.address = {
        Line1: row.ShipLine1 ?? "",
        Line2: row.ShipLine2 ?? "",
        City: row.ShipCity ?? "",
        State: row.ShipState ?? "",
        Pincode: row.ShipPincode ?? "",
      };
    }
    return customer;
  }
}
