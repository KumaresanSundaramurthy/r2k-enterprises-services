import { Module } from "@nestjs/common";
import { ExpenseIncomeModule } from "../expense-income/expense-income.module";
import { InvoicesModule } from "../invoices/invoices.module";
import { PaymentRecordsModule } from "../payment-records/payment-records.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { SalesReturnsController } from "./sales-returns.controller";
import { SalesReturnsService } from "./sales-returns.service";

@Module({
  imports: [TransactionsModule, InvoicesModule, PaymentRecordsModule, ExpenseIncomeModule],
  controllers: [SalesReturnsController],
  providers: [SalesReturnsService],
})
export class SalesReturnsModule {}
