import { Module } from "@nestjs/common";
import { CustomersModule } from "../customers/customers.module";
import { ProductMasterModule } from "../products/product-master.module";
import { SettingsModule } from "../settings/settings.module";
import { PackingListsRepository } from "../packing-lists/packing-lists.repository";
import { VendorsModule } from "../vendors/vendors.module";
import { CustomerNotesService } from "./customer-notes.service";
import { DocumentEffectsService } from "./document-effects.service";
import { DocumentPaymentsRepository } from "./document-payments.repository";
import { DocumentPaymentsService } from "./document-payments.service";
import { TransactionAttachmentsService } from "./transaction-attachments.service";
import { TransactionEngineService } from "./transaction-engine.service";
import { TransactionLookupsRepository } from "./transaction-lookups.repository";
import { TransactionPrefixesService } from "./transaction-prefixes.service";
import { TransactionPrintService } from "./transaction-print.service";
import { TransactionSearchService } from "./transaction-search.service";
import { TransactionSerialsService } from "./transaction-serials.service";
import { TransactionWritesRepository } from "./transaction-writes.repository";
import { TransactionsController } from "./transactions.controller";
import { TransactionsRepository } from "./transactions.repository";

const shared = [TransactionEngineService, TransactionsRepository, DocumentEffectsService, DocumentPaymentsService, DocumentPaymentsRepository, TransactionSerialsService, CustomerNotesService];

// The transaction engine and the shared /transactions endpoints; document modules (quotations, purchases, …) build on it
@Module({
  imports: [CustomersModule, SettingsModule, VendorsModule, ProductMasterModule],
  controllers: [TransactionsController],
  providers: [
    ...shared,
    TransactionWritesRepository,
    TransactionLookupsRepository,
    TransactionAttachmentsService,
    TransactionPrintService,
    TransactionSearchService,
    TransactionPrefixesService,
    PackingListsRepository,
  ],
  exports: [...shared, TransactionPrintService],
})
export class TransactionsModule {}
