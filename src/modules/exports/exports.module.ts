import { Module } from "@nestjs/common";
import { ActivityLogRepository } from "../activity-log/activity-log.repository";
import { CustomersModule } from "../customers/customers.module";
import { TransactionsModule } from "../transactions/transactions.module";
import { VendorsModule } from "../vendors/vendors.module";
import { ExportsController } from "./exports.controller";
import { ExportsRepository } from "./exports.repository";
import { ExportsService } from "./exports.service";

@Module({
  imports: [TransactionsModule, CustomersModule, VendorsModule],
  controllers: [ExportsController],
  providers: [ExportsService, ExportsRepository, ActivityLogRepository],
})
export class ExportsModule {}
