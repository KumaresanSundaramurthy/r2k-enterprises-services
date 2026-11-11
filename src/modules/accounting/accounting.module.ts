import { Module } from "@nestjs/common";
import { AccountingReportsService } from "./accounting-reports.service";
import { AccountingController } from "./accounting.controller";
import { AccountingRepository } from "./accounting.repository";
import { AccountingService } from "./accounting.service";

// CI3 Accounting controller + Accountledger_model (Chart of Accounts, journals, reports, period lock, budgets)
@Module({
  controllers: [AccountingController],
  providers: [AccountingService, AccountingReportsService, AccountingRepository],
})
export class AccountingModule {}
