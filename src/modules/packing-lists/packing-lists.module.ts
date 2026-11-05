import { Module } from "@nestjs/common";
import { TransactionsModule } from "../transactions/transactions.module";
import { PackingListsController } from "./packing-lists.controller";
import { PackingListsRepository } from "./packing-lists.repository";
import { PackingListsService } from "./packing-lists.service";

@Module({
  imports: [TransactionsModule],
  controllers: [PackingListsController],
  providers: [PackingListsService, PackingListsRepository],
})
export class PackingListsModule {}
