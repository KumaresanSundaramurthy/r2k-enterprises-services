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
import { VendorsModule } from "./modules/vendors/vendors.module";
import { ProductMasterModule } from "./modules/products/product-master.module";
import { OrganisationModule } from "./modules/organisation/organisation.module";
import { BranchesModule } from "./modules/branches/branches.module";
import { ProfileModule } from "./modules/profile/profile.module";
import { UsersModule } from "./modules/users/users.module";
import { RolesModule } from "./modules/roles/roles.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { DriveModule } from "./modules/drive/drive.module";
import { PrintThemesModule } from "./modules/print-themes/print-themes.module";
import { ActivityLogModule } from "./modules/activity-log/activity-log.module";

@Module({
  imports: [
    CoreModule,
    LibrariesModule,
    RedisModule,
    MailModule,
    CustomersModule,
    VendorsModule,
    ProductMasterModule,
    OrganisationModule,
    BranchesModule,
    ProfileModule,
    UsersModule,
    RolesModule,
    SettingsModule,
    DriveModule,
    PrintThemesModule,
    ActivityLogModule,
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
