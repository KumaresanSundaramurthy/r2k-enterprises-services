import { Module } from "@nestjs/common";
import { AppController, PingController } from "./app.controller";
import { AuthModule } from "./auth/auth.module";
import { ShopAuthModule } from "./shop-auth/shop-auth.module";
import { RedisModule } from "./common/redis/redis.module";
import { MailModule } from "./common/mail/mail.module";
import { ProductsModule } from "./products/products.module";
import { CartModule } from "./cart/cart.module";
import { OrdersModule } from "./orders/orders.module";
import { PaymentsModule } from "./payments/payments.module";
import { CoreModule } from "./core/core.module";
import { LibrariesModule } from "./libraries/libraries.module";
import { CustomersModule } from "./modules/customers/customers.module";

@Module({
  imports: [
    CoreModule,
    LibrariesModule,
    RedisModule,
    MailModule,
    CustomersModule,
    AuthModule,
    ShopAuthModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
  ],
  controllers: [AppController, PingController],
})
export class AppModule {}
