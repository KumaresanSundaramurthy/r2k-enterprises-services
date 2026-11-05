import { Module } from "@nestjs/common";
import { TransactionsModule } from "../transactions/transactions.module";
import { QuotationsController } from "./quotations.controller";
import { QuotationsService } from "./quotations.service";

@Module({
  imports: [TransactionsModule],
  controllers: [QuotationsController],
  providers: [QuotationsService],
})
export class QuotationsModule {}
