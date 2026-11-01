import { Injectable } from "@nestjs/common";
import { BALANCE_FY_START_MONTH } from "../../core/constants";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { financialYearStartDate, monthStartDate } from "../../core/utils/financial-year";
import { toInt } from "../../common/utils/php-compat";
import { ProductListDto, ProductListFilterDto } from "./dto/product-list.dto";
import { ProductMastersRepository } from "./product-masters.repository";
import { ProductsRepository } from "./products.repository";

const DROPDOWN_FIELDS = ["primaryUnit", "discType", "prodType", "prodTax", "taxDetails", "categories", "brands"];
const DAY_MS = 86400 * 1000;

// Item / combo reads of CI3's Products controller.
@Injectable()
export class ProductItemsService {
  constructor(
    private readonly products: ProductsRepository,
    private readonly masters: ProductMastersRepository,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // getProductList (isComposite 0) / getGroupList (1) — one page; the CI3 JS builds the rows and pagination.
  async getPage(orgUID: number, pageNo: number, isComposite: number, dto: ProductListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const page = Math.max(1, pageNo);
    const result = await this.products.listPaginated(orgUID, page, rowLimit, isComposite, dto.Filter ?? {}, dto.langCode);
    await this.masters.attachGalleries("Product", result.rows, "ProductUID");
    return {
      Data: result.rows,
      TotalCount: result.totalCount,
      PageNo: page,
      RowLimit: rowLimit,
      UIDs: result.rows.map((row) => row.ProductUID),
    };
  }

  // Groups page shown after a combo is saved (CI3 fetchProductTableData for IsComposite 1)
  async getGroupsPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: ProductListFilterDto) {
    return this.getPage(orgUID, pageNo, 1, { RowLimit: rowLimit, Filter: filter, langCode: "en" });
  }

  // getProductStats — list page counters (CI3 index() rendered these server-side)
  async getStats(orgUID: number) {
    return this.products.stats(orgUID, {
      monthStart: monthStartDate(0),
      fyStart: financialYearStartDate(BALANCE_FY_START_MONTH),
      sevenDaysAgo: new Date(Date.now() - 7 * DAY_MS).toISOString().slice(0, 10),
    });
  }

  // retrieveProductDetails — product, rental config, images and (size / brand products) variants
  async getDetail(orgUID: number, productUID: number, langCode: string) {
    if (!productUID || productUID <= 0) throw new CiValidationError("Invalid Product Information");
    const [data, rentalConfig, attachments] = await Promise.all([
      this.products.findDetail(orgUID, productUID, langCode),
      this.products.findRentalConfig(orgUID, productUID),
      this.masters.findAttachments(orgUID, "Product", productUID),
    ]);
    if (!data) throw new CiValidationError("Product not found");
    const hasVariants = toInt(data.IsBrandApplicable) === 1 || toInt(data.IsSizeApplicable) === 1;
    return {
      Message: "Retrieved Successfully",
      Data: data,
      RentalConfig: rentalConfig,
      Attachments: attachments,
      Variants: hasVariants ? await this.products.findVariants(orgUID, productUID) : [],
    };
  }

  // getRentalConfig
  async getRentalConfig(orgUID: number, productUID: number) {
    if (!productUID) throw new CiValidationError("Invalid product");
    return { Config: await this.products.findRentalConfig(orgUID, productUID) };
  }

  // getItemsForBOM — combo component search (items only)
  async itemsForBOM(orgUID: number, search: string | undefined, langCode: string) {
    return { Items: await this.products.itemsForBOM(orgUID, (search ?? "").trim(), langCode) };
  }

  // retrieveComboDetails — combo and its components (edit modal)
  async getCombo(orgUID: number, comboUID: number, langCode: string) {
    if (!comboUID) throw new CiValidationError("Invalid combo item.");
    const data = await this.products.findDetail(orgUID, comboUID, langCode, true);
    if (!data) throw new CiValidationError("Combo item not found.");
    return { Data: data, Components: await this.products.findBOM(comboUID, langCode) };
  }

  // getTransComboComponents — components with their selling price, for the transaction forms
  async getComboComponents(productUID: number, langCode: string) {
    if (!productUID) throw new CiValidationError("Invalid product.");
    return { Components: await this.products.findBOM(productUID, langCode) };
  }

  // getVariantStock
  async getVariants(orgUID: number, productUID: number) {
    if (productUID <= 0) throw new CiValidationError("Invalid ProductUID");
    return { Data: await this.products.findVariants(orgUID, productUID) };
  }

  // getUsedVariants — variants already in the stock ledger (locked on the edit form)
  async getUsedVariants(orgUID: number, productUID: number) {
    if (productUID <= 0) throw new CiValidationError("Invalid ProductUID");
    return { Data: await this.products.findUsedVariants(orgUID, productUID) };
  }

  // getProductVariantsForPricelist
  async getVariantsForPriceList(orgUID: number, productUID: number) {
    if (productUID <= 0) throw new CiValidationError("Invalid ProductUID");
    const variants = await this.products.findVariantLabels(orgUID, productUID);
    return { Variants: variants.map(({ ProductUID: _product, ...variant }) => variant) };
  }

  // getAvailableSerials — serial numbers in stock for a serial-tracked product
  async getAvailableSerials(orgUID: number, productUID: number) {
    if (productUID <= 0) throw new CiValidationError("ProductUID is required.");
    const serials = await this.products.availableSerials(orgUID, productUID);
    return { Serials: serials, Count: serials.length };
  }

  /**
   * getDropdownCache — the lookup lists of the product form (CI3 read Upstash first and fell back to these
   * queries; here they come from the database). `fields` limits the lists returned.
   */
  async getDropdowns(orgUID: number, fields: string[] | undefined, langCode: string) {
    const requested = (fields ?? []).flatMap((field) => String(field).split(",")).map((field) => field.trim());
    const wanted = requested.length > 0 ? DROPDOWN_FIELDS.filter((field) => requested.includes(field)) : DROPDOWN_FIELDS;
    const data: Record<string, unknown> = {};
    await Promise.all(
      wanted.map(async (field) => {
        if (field === "categories") data[field] = await this.masters.findCategories(orgUID, langCode);
        else if (field === "brands") data[field] = await this.masters.findBrands(orgUID);
        else data[field] = (await this.masters.lookup(field)) ?? [];
      })
    );
    return { Data: data };
  }
}
