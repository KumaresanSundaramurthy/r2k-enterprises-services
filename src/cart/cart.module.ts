import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { CartController } from "./cart.controller";
import { CartService } from "./cart.service";
import { CartRepository } from "./cart.repository";
import { ProductsModule } from "../products/products.module";

@Module({
  imports: [ProductsModule, PassportModule.register({ defaultStrategy: "jwt" })],
  controllers: [CartController],
  providers: [CartService, CartRepository],
  exports: [CartRepository],
})
export class CartModule {}
