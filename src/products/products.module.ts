import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";
import { ProductsRepository } from "./products.repository";

@Module({
  imports: [PassportModule.register({ defaultStrategy: "jwt" })],
  controllers: [ProductsController],
  providers: [ProductsService, ProductsRepository],
  exports: [ProductsRepository],
})
export class ProductsModule {}
