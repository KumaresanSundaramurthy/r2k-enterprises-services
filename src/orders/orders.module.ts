import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";
import { OrdersRepository } from "./orders.repository";
import { CartModule } from "../cart/cart.module";
import { ProductsModule } from "../products/products.module";

@Module({
  imports: [CartModule, ProductsModule, PassportModule.register({ defaultStrategy: "jwt" })],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
