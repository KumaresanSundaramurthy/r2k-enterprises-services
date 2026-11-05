import { Module } from "@nestjs/common";
import { InvoicesModule } from "../invoices/invoices.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { DeliveryChallansController } from "./delivery-challans.controller";
import { DeliveryChallansService } from "./delivery-challans.service";

@Module({
  imports: [TransactionsModule, InvoicesModule],
  controllers: [DeliveryChallansController],
  providers: [DeliveryChallansService],
})
export class DeliveryChallansModule {}
