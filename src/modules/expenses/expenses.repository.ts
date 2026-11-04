import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { DatabaseService } from "../../core/database/database.service";
import { EntryRecordsRepository } from "../expense-income/entry-records.repository";

type Row = Record<string, unknown>;

const ITEMS = "Transaction.ExpenseItemsTbl";

/** Expenses (CI3 Expenses_model): the shared record queries plus line items, TDS sections and the vendor's state. */
@Injectable()
export class ExpensesRepository extends EntryRecordsRepository {
  constructor(db: DatabaseService) {
    super(db, {
      table: "Transaction.ExpensesTbl",
      categoryTable: "Transaction.ExpenseCategoryTbl",
      uidColumn: "ExpenseUID",
      numberColumn: "ExpenseNumber",
      dateColumn: "ExpenseDate",
      settledColumn: "IsPaid",
      sourceType: "Expense",
      listColumns: ["TaxApplicable", "TaxAmount", "TDSApplicable", "TDSAmount"],
      detailColumns: (k) => [
        "r.CGSTTotal",
        "r.SGSTTotal",
        "r.IGSTTotal",
        "r.TDSApplicable",
        "r.TdsSectionUID",
        "r.TDSPercentage",
        "r.TDSAmount",
        "r.RCMApplicable",
        "r.RCMAmount",
        "r.RoundOff",
        "r.VendorUID",
        k.raw("IFNULL(v.Name, '') AS VendorName"),
        "r.SupplierInvoiceDate",
        "r.SupplierInvoiceSerialNo",
        k.raw("IFNULL(r.AmountType, 'NetAmount') AS AmountType"),
      ],
      joinVendor: true,
      allHidesCancelled: true,
      filtersByCategory: true,
    });
  }

  // getExpenseItems
  async items(orgUID: number, expenseUID: number): Promise<Row[]> {
    return this.read(ITEMS)
      .select("ExpenseItemUID", "CategoryUID", "ItemDescription", "Amount", "TaxPercentage", "TaxAmount", "CGSTAmount", "SGSTAmount", "IGSTAmount", "TotalAmount", "SortOrder")
      .where({ ExpenseUID: expenseUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("SortOrder", "asc");
  }

  async insertItem(trx: Knex.Transaction, row: Row): Promise<void> {
    await trx(ITEMS).insert(row);
  }

  // updateExpenseItem — a live line of this expense
  async updateItem(trx: Knex.Transaction, orgUID: number, expenseUID: number, itemUID: number, data: Row): Promise<void> {
    await trx(ITEMS).where({ ExpenseItemUID: itemUID, ExpenseUID: expenseUID, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  // softDeleteExpenseItem
  async deleteItems(trx: Knex.Transaction, orgUID: number, expenseUID: number, itemUIDs: number[], userUID: number): Promise<void> {
    if (itemUIDs.length === 0) return;
    await trx(ITEMS).whereIn("ExpenseItemUID", itemUIDs).where({ ExpenseUID: expenseUID, OrgUID: orgUID, IsDeleted: 0 }).update({ IsDeleted: 1, UpdatedBy: userUID });
  }

  // getTdsSections
  async tdsSections(): Promise<Row[]> {
    return this.read("Global.TdsSectionTbl")
      .select("TdsSectionUID", "SectionCode", "TaxRate", "Description")
      .where({ IsActive: 1 })
      .orderBy([{ column: "SortOrder" }, { column: "SectionCode" }]);
  }

  // State of the vendor's billing address (the edit form decides intra- / inter-state GST from it)
  async vendorBillingState(orgUID: number, vendorUID: number): Promise<string> {
    const row = await this.read("Vendors.VendAddressTbl")
      .select("State")
      .where({ VendorUID: vendorUID, OrgUID: orgUID, AddressType: "Billing", IsDeleted: 0, IsActive: 1 })
      .first();
    return row?.State ?? "";
  }
}
