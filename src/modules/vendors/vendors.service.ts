import { Injectable } from "@nestjs/common";
import { BALANCE_FY_START_MONTH } from "../../core/constants";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { currentFinancialYear, financialYearStartDate, monthStartDate } from "../../core/utils/financial-year";
import { postInt } from "../../core/utils/form-values";
import { resolveCdnUrl, toInt } from "../../common/utils/php-compat";
import { CreditSettingsService } from "../../libraries/credit-settings/credit-settings.service";
import { LocationService } from "../../libraries/location/location.service";
import { VendorListDto, VendorSearchListDto } from "./dto/vendor-list.dto";
import { VendorOpeningBalanceDto } from "./dto/vendor-write.dto";
import { Row, VendorsRepository } from "./vendors.repository";

const FORM_MODES = ["add", "edit", "clone"];

// Image (a stored path) as a full CDN URL
const withImageUrl = (row: Row): Row => (row.Image ? { ...row, Image: resolveCdnUrl(row.Image) } : row);

// Business rules of CI3's Vendors controller (reads); data access goes through VendorsRepository.
@Injectable()
export class VendorsService {
  constructor(
    private readonly vendors: VendorsRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly creditSettings: CreditSettingsService,
    private readonly location: LocationService
  ) {}

  // getVendorsPageDetails — one page of the vendor list; the CI3 JS builds the rows and pagination.
  async getPage(orgUID: number, pageNo: number, dto: VendorListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const page = Math.max(1, pageNo);
    const result = await this.vendors.listPaginated(orgUID, page, rowLimit, dto.Filter ?? {}, dto.langCode);
    return { Data: result.rows.map(withImageUrl), TotalCount: result.totalCount, PageNo: page, RowLimit: rowLimit };
  }

  /**
   * getVendorSearchList — vendor picker of the purchase forms, sorted like the list (CI3 read the Upstash
   * map first and fell back to this query; the result has the same shape either way).
   */
  async searchWithBalance(dto: VendorSearchListDto) {
    const search = (dto.Search ?? "").trim().toLowerCase();
    const result = await this.vendors.listPaginated(dto.orgId, dto.PageNo, dto.RowLimit, search ? { SearchAllData: search } : {}, dto.langCode);
    const addresses = await this.vendors.findBillingAddresses(
      result.rows.map((row) => toInt(row.VendorUID)),
      dto.langCode
    );
    const billingOf = new Map<number, Row>();
    for (const address of addresses) if (!billingOf.has(toInt(address.VendorUID))) billingOf.set(toInt(address.VendorUID), address);

    const Vendors = result.rows.map((row) => {
      const vendor: Record<string, unknown> = {
        VendorUID: row.VendorUID,
        Name: row.Name,
        Area: row.Area ?? "",
        MobileNumber: row.MobileNumber ?? "",
        Balance: row.ClosingBalance ?? 0,
        BalanceType: row.ClosingBalanceType ?? "Credit",
      };
      const billing = billingOf.get(toInt(row.VendorUID));
      if (billing) {
        vendor.address = {
          Line1: billing.Line1 ?? "",
          Line2: billing.Line2 ?? "",
          City: billing.CityText ?? "",
          State: billing.StateText ?? "",
          Pincode: billing.Pincode ?? "",
        };
      }
      return vendor;
    });
    return { Vendors, TotalCount: result.totalCount };
  }

  // getVendorForModal — vendor with bank details, billing/shipping address and attachments.
  async getDetail(orgUID: number, vendorUID: number, langCode: string) {
    if (!Number.isInteger(vendorUID) || vendorUID <= 0) throw new CiValidationError("Invalid vendor ID.");
    const [vendor, attachments, bankDetails, addresses] = await Promise.all([
      this.vendors.findDetail(orgUID, vendorUID, langCode),
      this.vendors.findAttachments(orgUID, vendorUID),
      this.vendors.findBankDetails(vendorUID),
      this.vendors.findAddresses(vendorUID, langCode),
    ]);
    if (!vendor) throw new CiValidationError("Vendor not found.");
    return {
      Data: withImageUrl(vendor),
      BankDetails: bankDetails,
      BillingAddr: addresses.find((address) => address.AddressType === "Billing") ?? null,
      ShippingAddr: addresses.find((address) => address.AddressType === "Shipping") ?? null,
      Attachments: attachments,
    };
  }

  /**
   * loadModalForm — data for the add / edit / clone form (CI3 rendered vendors/forms/modal_body.php as Html;
   * here the values that view used, plus the country / state / city lists).
   */
  async getModalForm(orgUID: number, type: string, vendorUID: number, langCode: string) {
    const formMode = FORM_MODES.includes(type) ? type : "add";
    const countryISO2 = await this.location.orgCountryISO2(orgUID);
    const [countries, states, cities] = await Promise.all([
      this.location.countries(),
      countryISO2 ? this.location.states(countryISO2) : Promise.resolve([]),
      countryISO2 ? this.location.cities(countryISO2) : Promise.resolve([]),
    ]);

    let formData: Row | null = null;
    let bankDetails: Row[] = [];
    let addresses: Row[] = [];
    if (formMode !== "add" && vendorUID > 0) {
      formData = await this.vendors.findDetail(orgUID, vendorUID, langCode);
      if (formData) {
        [bankDetails, addresses] = await Promise.all([this.vendors.findBankDetails(vendorUID), this.vendors.findAddresses(vendorUID, langCode)]);
      }
    }
    return {
      FormMode: formMode,
      FormData: formData ? withImageUrl(formData) : null,
      BankDetails: bankDetails,
      BillingAddr: addresses.find((address) => address.AddressType === "Billing") ?? null,
      ShippingAddr: addresses.find((address) => address.AddressType === "Shipping") ?? null,
      CountryInfo: countries,
      StateData: states,
      CityData: cities,
      ImgData: formData?.Image ? resolveCdnUrl(formData.Image) : "",
    };
  }

  // getVendorTags
  async getTags(orgUID: number) {
    return { Tags: await this.vendors.findTags(orgUID) };
  }

  // getStats — header counters of the list page (CI3 index() rendered these server-side).
  async getStats(orgUID: number) {
    const stats = await this.vendors.stats(orgUID, {
      monthStart: monthStartDate(0),
      nextMonthStart: monthStartDate(1),
      lastMonthStart: monthStartDate(-1),
      // CI3 counts the vendor FY from April
      fyStart: financialYearStartDate(BALANCE_FY_START_MONTH),
    });
    return { Stats: stats };
  }

  // getVendorOpeningBalance — current opening/closing row plus the snapshot for one financial year.
  async getOpeningBalance(dto: VendorOpeningBalanceDto) {
    const vendorUID = postInt(dto, "VendorUID");
    if (vendorUID <= 0) throw new CiValidationError("Invalid vendor.");
    const requestedYear = postInt(dto, "FinancialYear");
    const financialYear = requestedYear > 0 ? requestedYear : currentFinancialYear(BALANCE_FY_START_MONTH);
    const [current, yearRow] = await Promise.all([
      this.vendors.findOpeningBalance(dto.orgId, vendorUID),
      this.vendors.findYearOpening(dto.orgId, vendorUID, financialYear),
    ]);
    return { Data: current, YearData: yearRow, FinancialYear: financialYear };
  }

  // getNextVendorNumber — number to pre-fill on the "new vendor" form.
  async getNextNumber(orgUID: number) {
    const org = await this.orgSettings.get(orgUID);
    return { VendorNumber: await this.creditSettings.getVendorNextNumber(org) };
  }
}
