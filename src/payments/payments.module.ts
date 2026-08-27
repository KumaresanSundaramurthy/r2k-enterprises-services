import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { OrdersModule } from "../orders/orders.module";

@Module({
  imports: [OrdersModule, PassportModule.register({ defaultStrategy: "jwt" })],
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
