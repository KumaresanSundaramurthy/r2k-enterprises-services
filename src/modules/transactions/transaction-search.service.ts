import { Injectable } from "@nestjs/common";
import { smartDecimal } from "../../common/utils/php-compat";
import { VendorListFilterDto } from "../vendors/dto/vendor-list.dto";
import { VendorsRepository } from "../vendors/vendors.repository";
import { TransactionLookupsRepository } from "./transaction-lookups.repository";

const num = (value: unknown) => Number(value ?? 0) || 0;

/** The party and product pickers of the transaction forms (CI3 Transactions::searchCustomers / searchVendors / searchTransProducts). */
@Injectable()
export class TransactionSearchService {
  constructor(
    private readonly lookups: TransactionLookupsRepository,
    private readonly vendors: VendorsRepository
  ) {}

  // searchVendors — select2 rows (20 vendors) with the closing balance
  async vendorList(orgUID: number, term: string, langCode: string) {
    const filter = Object.assign(new VendorListFilterDto(), term.trim() ? { SearchAllData: term.trim() } : {});
    const { rows } = await this.vendors.listPaginated(orgUID, 1, 20, filter, langCode);
    return {
      Lists: rows.map((row) => ({
        id: Number(row.VendorUID),
        text: row.Area ? `${row.Name} (${row.Area})` : row.Name,
        name: row.Name,
        area: row.Area ?? "",
        companyName: row.CompanyName ?? "",
        balance: num(row.ClosingBalance),
        balanceType: row.ClosingBalanceType ?? "Credit",
      })),
    };
  }

  // searchCustomers — select2 rows with balance and (shipping, else billing) address
  async customers(orgUID: number, term: string, langCode: string) {
    const rows = await this.lookups.searchCustomers(orgUID, term.trim(), langCode);
    return {
      Lists: rows.map((row) => ({
        id: row.CustomerUID,
        text: row.Area ? `${row.Name} (${row.Area})` : row.Name,
        name: row.Name,
        area: row.Area ?? "",
        balance: num(row.CustomerBalance),
        balanceType: row.BalanceType ?? "Debit",
        ...(row.AddrUID ? { address: { Line1: row.Line1, Line2: row.Line2, Pincode: row.Pincode, City: row.CityText, State: row.StateText } } : {}),
      })),
    };
  }

  // searchTransProducts — the selling price is tax-inclusive: unitPrice is the price before tax
  async products(orgUID: number, term: string, categoryUID: number, langCode: string) {
    const rows = await this.lookups.searchProducts(orgUID, term.trim(), categoryUID, langCode);
    return {
      Lists: rows.map((row) => {
        const selling = num(row.SellingPrice);
        const taxPercent = num(row.TaxPercentage);
        const unitPrice = smartDecimal(selling / (1 + taxPercent / 100), 8);
        return {
          id: Number(row.ProductUID),
          text: row.ItemName,
          itemName: row.ItemName,
          productType: row.ProductType,
          unitPrice: Number(unitPrice),
          taxAmount: Number(smartDecimal(selling - Number(unitPrice))),
          sellingPrice: Number(smartDecimal(selling)),
          purchasePrice: Number(smartDecimal(row.PurchasePrice)),
          mrp: Number(smartDecimal(row.MRP)),
          purchasePriceTaxUID: num(row.PurchasePriceProductTaxUID),
          purchasePriceIsIncl: (row.PurchasePriceProductTaxUID === null || row.PurchasePriceProductTaxUID === undefined ? 1 : num(row.PurchasePriceProductTaxUID)) === 1,
          availableQuantity: num(row.AvailableQuantity),
          hsnCode: row.HSNSACCode,
          category: row.CatgName,
          categoryUID: row.CategoryUID ? Number(row.CategoryUID) : null,
          categoryName: row.CatgName ?? "",
          partNumber: row.PartNumber ?? "",
          taxPercent,
          cgstPercent: num(row.CGST),
          sgstPercent: num(row.SGST),
          igstPercent: num(row.IGST),
          discount: Number(smartDecimal(row.Discount)),
          discountType: row.DiscountTypeName,
          primaryUnit: row.priUnitShortName,
          description: row.Description ?? "",
          isComboItem: num(row.IsComboItem),
          comboItemCount: num(row.ComboItemCount),
          IsBrandApplicable: num(row.IsBrandApplicable),
        };
      }),
    };
  }
}
