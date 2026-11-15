import { Module } from "@nestjs/common";
import { TransactionsModule } from "../transactions/transactions.module";
import { DocController } from "./doc.controller";
import { DocService } from "./doc.service";

// Public shared-document links (CI3 Doc controller)
@Module({
  imports: [TransactionsModule],
  controllers: [DocController],
  providers: [DocService],
})
export class DocModule {}
