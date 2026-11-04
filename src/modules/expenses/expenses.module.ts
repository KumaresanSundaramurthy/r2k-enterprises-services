import { Module } from "@nestjs/common";
import { ExpenseIncomeModule } from "../expense-income/expense-income.module";
import { VendorsModule } from "../vendors/vendors.module";
import { ExpensesController } from "./expenses.controller";
import { ExpensesRepository } from "./expenses.repository";
import { ExpensesService } from "./expenses.service";

@Module({
  imports: [ExpenseIncomeModule, VendorsModule],
  controllers: [ExpensesController],
  providers: [ExpensesService, ExpensesRepository],
})
export class ExpensesModule {}
