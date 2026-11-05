import { Module } from "@nestjs/common";
import { ExpenseIncomeModule } from "../expense-income/expense-income.module";
import { PaymentRecordsModule } from "../payment-records/payment-records.module";
import { PurchasePriceListModule } from "../purchase-price-list/purchase-price-list.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { PurchasePaymentsService } from "./purchase-payments.service";
import { PurchasesController } from "./purchases.controller";
import { PurchasesRepository } from "./purchases.repository";
import { PurchasesService } from "./purchases.service";

// Purchase Bills page (module 105); its repository is shared with Purchase Returns
@Module({
  imports: [TransactionsModule, PaymentRecordsModule, PurchasePriceListModule, ExpenseIncomeModule],
  controllers: [PurchasesController],
  providers: [PurchasesService, PurchasePaymentsService, PurchasesRepository],
  exports: [PurchasesRepository],
})
export class PurchasesModule {}
