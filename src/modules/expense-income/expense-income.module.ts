import { Module } from "@nestjs/common";
import { EntryAttachmentsService } from "./entry-attachments.service";
import { EntryCategoriesService } from "./entry-categories.service";
import { EntryPaymentsService } from "./entry-payments.service";
import { EntryToolkit } from "./entry-record.service";
import { EntryRepository } from "./entry.repository";

const shared = [EntryRepository, EntryPaymentsService, EntryAttachmentsService, EntryCategoriesService, EntryToolkit];

// What the Expenses and Indirect Income pages share: payments, attachments, categories and lookups
@Module({
  providers: shared,
  exports: shared,
})
export class ExpenseIncomeModule {}
