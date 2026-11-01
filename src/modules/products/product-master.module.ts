import { Module } from "@nestjs/common";
import { PriceListsRepository } from "./price-lists.repository";
import { PriceListsService } from "./price-lists.service";
import { ProductAttachmentService } from "./product-attachment.service";
import { ProductBrandsService } from "./product-brands.service";
import { ProductCacheService } from "./product-cache.service";
import { ProductCategoriesService } from "./product-categories.service";
import { ProductItemsController } from "./product-items.controller";
import { ProductItemsService } from "./product-items.service";
import { PriceListsController, ProductBrandsController, ProductCategoriesController, ProductSizesController } from "./product-masters.controller";
import { ProductMastersRepository } from "./product-masters.repository";
import { ProductProfileRepository } from "./product-profile.repository";
import { ProductProfileService } from "./product-profile.service";
import { ProductSizesService } from "./product-sizes.service";
import { ProductTextService } from "./product-text.service";
import { ProductWriteService } from "./product-write.service";
import { ProductsRepository } from "./products.repository";

/**
 * The ERP Products page migrated from CI3 (items, combos, categories, brands, sizes, price lists) under
 * /api/products. Imported before the store's ProductsModule so these named routes match before its /:id route.
 */
@Module({
  controllers: [ProductItemsController, ProductCategoriesController, ProductBrandsController, ProductSizesController, PriceListsController],
  providers: [
    ProductsRepository,
    ProductMastersRepository,
    PriceListsRepository,
    ProductProfileRepository,
    ProductTextService,
    ProductCacheService,
    ProductAttachmentService,
    ProductItemsService,
    ProductWriteService,
    ProductCategoriesService,
    ProductBrandsService,
    ProductSizesService,
    PriceListsService,
    ProductProfileService,
  ],
  exports: [ProductsRepository, ProductCacheService],
})
export class ProductMasterModule {}
