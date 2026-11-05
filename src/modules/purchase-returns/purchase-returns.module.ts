import { Module } from "@nestjs/common";
import { ExpenseIncomeModule } from "../expense-income/expense-income.module";
import { PaymentRecordsModule } from "../payment-records/payment-records.module";
import { PurchasesModule } from "../purchases/purchases.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { PurchaseReturnsController } from "./purchase-returns.controller";
import { PurchaseReturnsService } from "./purchase-returns.service";

@Module({
  imports: [TransactionsModule, PurchasesModule, PaymentRecordsModule, ExpenseIncomeModule],
  controllers: [PurchaseReturnsController],
  providers: [PurchaseReturnsService],
})
export class PurchaseReturnsModule {}
