import { Module } from "@nestjs/common";
import { ExpenseIncomeModule } from "../expense-income/expense-income.module";
import { PaymentRecordsModule } from "../payment-records/payment-records.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { InvoicesController } from "./invoices.controller";
import { InvoicesService } from "./invoices.service";
import { SalesRepository } from "./sales.repository";

// Invoices page (module 103); its sales repository is shared with Sales Returns and Delivery Challans
@Module({
  imports: [TransactionsModule, PaymentRecordsModule, ExpenseIncomeModule],
  controllers: [InvoicesController],
  providers: [InvoicesService, SalesRepository],
  exports: [SalesRepository],
})
export class InvoicesModule {}
