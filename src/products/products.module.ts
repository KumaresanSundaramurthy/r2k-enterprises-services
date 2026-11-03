import { Module } from "@nestjs/common";
import { ProductsRepository } from "./products.repository";

// Online-store product lookups for cart and orders (the store's own product endpoints were removed)
@Module({
  providers: [ProductsRepository],
  exports: [ProductsRepository],
})
export class ProductsModule {}
