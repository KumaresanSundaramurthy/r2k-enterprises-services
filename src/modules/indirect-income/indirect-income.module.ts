import { Module } from "@nestjs/common";
import { ExpenseIncomeModule } from "../expense-income/expense-income.module";
import { IndirectIncomeController } from "./indirect-income.controller";
import { IndirectIncomeRepository } from "./indirect-income.repository";
import { IndirectIncomeService } from "./indirect-income.service";

@Module({
  imports: [ExpenseIncomeModule],
  controllers: [IndirectIncomeController],
  providers: [IndirectIncomeService, IndirectIncomeRepository],
})
export class IndirectIncomeModule {}
