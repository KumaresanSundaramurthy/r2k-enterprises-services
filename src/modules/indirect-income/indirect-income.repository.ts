import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service";
import { EntryRecordsRepository } from "../expense-income/entry-records.repository";

/** Indirect income records (CI3 Indirectincome_model): the shared record queries on IndirectIncomeTbl. */
@Injectable()
export class IndirectIncomeRepository extends EntryRecordsRepository {
  constructor(db: DatabaseService) {
    super(db, {
      table: "Transaction.IndirectIncomeTbl",
      categoryTable: "Transaction.IndirectIncomeCategoryTbl",
      uidColumn: "IncomeUID",
      numberColumn: "IncomeNumber",
      dateColumn: "IncomeDate",
      settledColumn: "IsReceived",
      sourceType: "IndirectIncome",
      listColumns: ["TaxApplicable", "TaxAmount"],
      detailColumns: () => [],
      joinVendor: false,
      allHidesCancelled: false,
      filtersByCategory: true,
    });
  }
}
