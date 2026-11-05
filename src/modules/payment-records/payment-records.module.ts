import { Module } from "@nestjs/common";
import { CustomersModule } from "../customers/customers.module";
import { PaymentBanksService } from "./payment-banks.service";
import { PaymentReceiptService } from "./payment-receipt.service";
import { PaymentRecordsController } from "./payment-records.controller";
import { PaymentRecordsRepository } from "./payment-records.repository";
import { PaymentRecordsService } from "./payment-records.service";
import { PaymentWriteService } from "./payment-write.service";
import { PaymentWritesRepository } from "./payment-writes.repository";

// Payments page of the ERP (CI3 Payments controller); the online store's payments live in src/payments
@Module({
  imports: [CustomersModule],
  controllers: [PaymentRecordsController],
  providers: [PaymentRecordsService, PaymentRecordsRepository, PaymentWriteService, PaymentWritesRepository, PaymentReceiptService, PaymentBanksService],
  exports: [PaymentRecordsRepository],
})
export class PaymentRecordsModule {}
