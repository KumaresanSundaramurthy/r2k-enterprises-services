import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AuthModule } from "./auth/auth.module";
import { ShopAuthModule } from "./shop-auth/shop-auth.module";
import { RedisModule } from "./common/redis/redis.module";
import { MailModule } from "./common/mail/mail.module";
import { ProductsModule } from "./products/products.module";
import { CartModule } from "./cart/cart.module";
import { OrdersModule } from "./orders/orders.module";
import { PaymentsModule } from "./payments/payments.module";

@Module({
  imports: [
    RedisModule,
    MailModule,
    AuthModule,
    ShopAuthModule,
    ProductsModule,
    CartModule,
    OrdersModule,
    PaymentsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
