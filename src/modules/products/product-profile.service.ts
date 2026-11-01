import { Injectable } from "@nestjs/common";
import { CiValidationError } from "../../core/response/ci-response";
import { ProductProfileRepository } from "./product-profile.repository";
import { ProductsRepository } from "./products.repository";

/**
 * Product profile modal (CI3 getProductProfileTab). CI3 returned the overview, stock and history tabs as
 * rendered HTML (transactions already as Rows); here every tab returns its values as data.
 */
@Injectable()
export class ProductProfileService {
  constructor(
    private readonly profile: ProductProfileRepository,
    private readonly products: ProductsRepository
  ) {}

  async getTab(orgUID: number, productUID: number, tab: string, langCode: string) {
    if (!Number.isInteger(productUID) || productUID <= 0) throw new CiValidationError("Invalid product ID.");
    const name = tab.toLowerCase().replace(/[^a-z]/g, "");
    switch (name) {
      case "overview": {
        const prod = await this.profile.profile(orgUID, productUID, langCode);
        if (!prod) throw new CiValidationError("Product not found.");
        return { Tab: name, Data: { Prod: prod, TopCustomers: await this.profile.topCustomers(orgUID, productUID), ProductUID: productUID } };
      }
      case "transactions":
        return { Tab: name, Rows: await this.profile.transactions(orgUID, productUID) };
      case "stock": {
        const [prod, moves, variants] = await Promise.all([
          this.profile.profile(orgUID, productUID, langCode),
          this.profile.stockMovements(orgUID, productUID),
          this.products.findVariants(orgUID, productUID),
        ]);
        return { Tab: name, Data: { Prod: prod, Moves: moves, Variants: variants, ProductUID: productUID } };
      }
      case "history":
        return { Tab: name, Data: { Rows: await this.profile.auditHistory(orgUID, productUID), ProductUID: productUID } };
      default:
        throw new CiValidationError("Unknown tab.");
    }
  }
}
