import { Module } from "@nestjs/common";
import { TransactionsModule } from "../transactions/transactions.module";
import { SalesOrdersController } from "./sales-orders.controller";
import { SalesOrdersService } from "./sales-orders.service";

@Module({
  imports: [TransactionsModule],
  controllers: [SalesOrdersController],
  providers: [SalesOrdersService],
})
export class SalesOrdersModule {}
