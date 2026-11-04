import { Injectable } from "@nestjs/common";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { PriceListFilter, PurchasePriceListRepository } from "./purchase-price-list.repository";

/**
 * Purchase Price List page (CI3 Purchasepricelist controller): the latest purchase price of each product from
 * each vendor (kept up to date by purchases), and an entry's price history. Read-only.
 */
@Injectable()
export class PurchasePriceListService {
  constructor(
    private readonly repo: PurchasePriceListRepository,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // getPageDetails — the CI3 JS builds the rows from Data
  async getPage(orgUID: number, branchUID: number, pageNo: number, rowLimit: number | undefined, filter: PriceListFilter) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const { rows, total } = await this.repo.list(orgUID, branchUID, filter, limit, (pageNo - 1) * limit);
    return { Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: limit };
  }

  // view / getDetailPageData — the entry and a page of its price history
  async getDetail(orgUID: number, priceListUID: number, pageNo: number, rowLimit: number | undefined) {
    if (priceListUID <= 0) throw new CiValidationError("Invalid entry.");
    const entry = await this.repo.entry(orgUID, priceListUID);
    if (!entry) throw new CiValidationError("Entry not found.");
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const { rows, total } = await this.repo.history(orgUID, Number(entry.ProductUID), Number(entry.VendorUID), limit, (pageNo - 1) * limit);
    return { Entry: entry, Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: limit };
  }
}
