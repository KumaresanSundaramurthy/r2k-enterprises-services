import { Module } from "@nestjs/common";
import { TransactionsModule } from "../transactions/transactions.module";
import { ProformaInvoicesController } from "./proforma-invoices.controller";
import { ProformaInvoicesService } from "./proforma-invoices.service";

@Module({
  imports: [TransactionsModule],
  controllers: [ProformaInvoicesController],
  providers: [ProformaInvoicesService],
})
export class ProformaInvoicesModule {}
