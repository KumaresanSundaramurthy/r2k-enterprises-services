import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

// List filter the CI3 pages post (JSON): status tab or several statuses, date range, search text and column filters
export interface EntryListFilter {
  Status?: string;
  StatusList?: unknown;
  DateFrom?: string;
  DateTo?: string;
  Name?: string;
  CategoryUIDs?: unknown;
  PaymentTypeUIDs?: unknown;
  UpdatedByUIDs?: unknown;
  BranchUID?: number;
}

/** Where an expense / income record lives and how its page lists it. */
export interface RecordTable {
  table: string;
  categoryTable: string;
  uidColumn: string;
  numberColumn: string;
  dateColumn: string;
  // IsPaid (expenses) / IsReceived (income)
  settledColumn: string;
  sourceType: string;
  // Columns of the list rows beyond the common ones
  listColumns: string[];
  // Columns of one record (getExpenseById / getIncomeById) beyond the common ones
  detailColumns: (k: Knex) => (string | Knex.Raw)[];
  // Expenses join the vendor for VendorName
  joinVendor: boolean;
  // The "All" tab leaves cancelled records out (expenses only)
  allHidesCancelled: boolean;
  // Category column filter (expenses only)
  filtersByCategory: boolean;
}

// Positive integer IDs from an array or a single value (CI3 array_filter(array_map('intval', (array)…)))
const intList = (value: unknown): number[] =>
  ([] as unknown[])
    .concat(value ?? [])
    .map((item) => parseInt(String(item), 10))
    .filter((id) => id > 0);

/**
 * Expense and indirect income records (CI3 Expenses_model / Indirectincome_model): the two models are the same
 * queries on different tables, so each page's repository is this class with its own RecordTable.
 */
export abstract class EntryRecordsRepository extends BaseRepository {
  protected constructor(
    db: DatabaseService,
    readonly spec: RecordTable
  ) {
    super(db);
  }

  // getExpenseList / getIncomeList — newest first, with category, users, attachment and payment summaries
  async list(orgUID: number, filter: EntryListFilter, limit: number, offset: number): Promise<Row[]> {
    const { spec } = this;
    const k = this.read;
    return this.base(orgUID, filter)
      .select(
        `r.${spec.uidColumn}`,
        `r.${spec.numberColumn}`,
        `r.${spec.dateColumn}`,
        "r.Amount",
        "r.NetAmount",
        "r.PaidAmount",
        "r.BalanceAmount",
        ...spec.listColumns.map((column) => `r.${column}`),
        "r.CategoryUID",
        "c.CategoryName",
        "r.Notes",
        "r.DocStatus",
        `r.${spec.settledColumn}`,
        "r.UpdatedOn",
        k.raw("CONCAT(IFNULL(u.FirstName,''), ' ', IFNULL(u.LastName,'')) AS UpdatedBy"),
        k.raw("CONCAT(IFNULL(uc.FirstName,''), ' ', IFNULL(uc.LastName,'')) AS CreatedByName"),
        k.raw(
          `(SELECT COUNT(*) FROM Transaction.ExpenseIncomeAttachmentsTbl a WHERE a.SourceUID = r.${spec.uidColumn} AND a.SourceType = ? AND a.IsDeleted = 0) AS AttachCount`,
          [spec.sourceType]
        ),
        k.raw("IFNULL(PayInfo.PaymentCount, 0) AS PaymentCount"),
        "PayInfo.PaymentModes",
        "PayInfo.PayBankName",
        "PayInfo.PayAccountNumber",
        k.raw("IFNULL(PayInfo.PaymentAttachmentCount, 0) AS PaymentAttachmentCount")
      )
      .leftJoin("Users.UserTbl as u", "u.UserUID", "r.UpdatedBy")
      .leftJoin("Users.UserTbl as uc", "uc.UserUID", "r.CreatedBy")
      .leftJoin(this.paymentSummary(orgUID), "PayInfo.TransUID", `r.${spec.uidColumn}`)
      .orderBy(`r.${spec.uidColumn}`, "desc")
      .limit(limit)
      .offset(offset);
  }

  async count(orgUID: number, filter: EntryListFilter): Promise<number> {
    const row = await this.base(orgUID, filter).count("* as cnt").first();
    return Number(row?.cnt ?? 0);
  }

  // getExpenseUIDsByFilter / getIncomeUIDsByFilter — for "select all" bulk delete
  async uidsByFilter(orgUID: number, filter: EntryListFilter): Promise<number[]> {
    const rows = await this.base(orgUID, filter).select(`r.${this.spec.uidColumn} as UID`);
    return rows.map((row: Row) => Number(row.UID));
  }

  // getExpenseById / getIncomeById — with its category, (first) payment and bank account
  async find(orgUID: number, uid: number, trx?: Knex.Transaction): Promise<Row | null> {
    const { spec } = this;
    const k = trx ?? this.read;
    const query = k(`${spec.table} as r`)
      .select(
        `r.${spec.uidColumn}`,
        `r.${spec.numberColumn}`,
        `r.${spec.dateColumn}`,
        "r.Amount",
        "r.NetAmount",
        "r.PaidAmount",
        "r.BalanceAmount",
        "r.TaxApplicable",
        "r.TaxPercentage",
        "r.TaxAmount",
        ...spec.detailColumns(k),
        "r.CategoryUID",
        "c.CategoryName",
        "r.Notes",
        "r.DocStatus",
        `r.${spec.settledColumn}`,
        "py.PaymentUID",
        "py.PaymentTypeUID",
        "pt.Name as PaymentTypeName",
        "py.BankAccountUID",
        "ba.AccountName as BankAccountName",
        "ba.BankName",
        "ba.AccountNumber",
        "py.PaymentDate",
        "py.UniqueNumber as PaymentReference",
        "py.Notes as PaymentNotes",
        "r.CreatedOn",
        "r.UpdatedOn",
        k.raw("CONCAT(u.FirstName, ' ', IFNULL(u.LastName, '')) AS UpdatedByName")
      )
      .leftJoin(`${spec.categoryTable} as c`, (on) => on.on("c.CategoryUID", "r.CategoryUID").andOnVal("c.IsDeleted", "=", 0))
      .leftJoin("Transaction.PaymentsTbl as py", (on) =>
        on.on("py.TransUID", `r.${spec.uidColumn}`).andOnVal("py.SourceType", "=", spec.sourceType).andOnVal("py.IsDeleted", "=", 0)
      )
      .leftJoin("Global.PaymentTypesTbl as pt", "pt.PaymentTypeUID", "py.PaymentTypeUID")
      .leftJoin("Organisation.OrgBankAccountsTbl as ba", (on) => on.on("ba.BankAccountUID", "py.BankAccountUID").andOnVal("ba.IsDeleted", "=", 0))
      .leftJoin("Users.UserTbl as u", "u.UserUID", "r.UpdatedBy")
      .where({ [`r.${spec.uidColumn}`]: uid, "r.OrgUID": orgUID, "r.IsDeleted": 0 });
    if (spec.joinVendor) query.leftJoin("Vendors.VendorTbl as v", "v.VendorUID", "r.VendorUID");
    return (await query.first()) ?? null;
  }

  // getExpenseSummaryStats / getIncomeSummaryStats — count and total per status
  async summaryStats(orgUID: number, branchUID: number): Promise<Record<string, { count: number; amount: number }>> {
    const query = this.read(`${this.spec.table} as r`)
      .select("r.DocStatus")
      .count("* as cnt")
      .sum("r.NetAmount as total")
      .where({ "r.OrgUID": orgUID, "r.IsDeleted": 0 })
      .groupBy("r.DocStatus");
    if (branchUID > 0) query.where("r.BranchUID", branchUID);
    const stats: Record<string, { count: number; amount: number }> = {};
    for (const row of (await query) as Row[]) stats[String(row.DocStatus)] = { count: Number(row.cnt), amount: Number(row.total ?? 0) };
    return stats;
  }

  async insert(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx(this.spec.table).insert(row);
    return Number(id);
  }

  // A live record of the organisation
  async update(trx: Knex.Transaction | null, orgUID: number, uid: number, data: Row): Promise<void> {
    await (trx ?? this.db.write)(this.spec.table)
      .where({ [this.spec.uidColumn]: uid, OrgUID: orgUID, IsDeleted: 0 })
      .update(data);
  }

  // EXP-0001 / INC-0001 from the new record's ID
  async setNumber(trx: Knex.Transaction, orgUID: number, uid: number, number: string): Promise<void> {
    await trx(this.spec.table).where({ [this.spec.uidColumn]: uid, OrgUID: orgUID }).update({ [this.spec.numberColumn]: number });
  }

  // Per record: payment count, modes, the bank of a non-cash payment and the payments' attachment count
  private paymentSummary(orgUID: number): Knex.Raw {
    return this.read.raw(
      `(SELECT P.TransUID,
          COUNT(*) AS PaymentCount,
          GROUP_CONCAT(PT.Name ORDER BY P.PaymentUID ASC SEPARATOR ',') AS PaymentModes,
          MAX(CASE WHEN PT.IsCash = 0 THEN BA.BankName ELSE NULL END) AS PayBankName,
          MAX(CASE WHEN PT.IsCash = 0 THEN BA.AccountNumber ELSE NULL END) AS PayAccountNumber,
          (SELECT COUNT(*) FROM Transaction.PaymentAttachmentsTbl PA
             WHERE PA.PaymentUID IN (SELECT PaymentUID FROM Transaction.PaymentsTbl P2
                                      WHERE P2.TransUID = P.TransUID AND P2.SourceType = ? AND P2.IsDeleted = 0 AND P2.IsActive = 1)
               AND PA.IsDeleted = 0 AND PA.IsActive = 1) AS PaymentAttachmentCount
        FROM Transaction.PaymentsTbl P
        JOIN Global.PaymentTypesTbl PT ON PT.PaymentTypeUID = P.PaymentTypeUID
        LEFT JOIN Organisation.OrgBankAccountsTbl BA ON BA.BankAccountUID = P.BankAccountUID
        WHERE P.IsDeleted = 0 AND P.IsActive = 1 AND P.SourceType = ? AND P.OrgUID = ?
        GROUP BY P.TransUID) AS PayInfo`,
      [this.spec.sourceType, this.spec.sourceType, orgUID]
    );
  }

  // The organisation's live records with the category joined and the list filters applied (_applyFilters)
  private base(orgUID: number, filter: EntryListFilter): Knex.QueryBuilder {
    const { spec } = this;
    const query = this.read(`${spec.table} as r`)
      .leftJoin(`${spec.categoryTable} as c`, (on) => on.on("c.CategoryUID", "r.CategoryUID").andOnVal("c.IsDeleted", "=", 0))
      .where({ "r.OrgUID": orgUID, "r.IsDeleted": 0 });

    if (Number(filter.BranchUID) > 0) query.where("r.BranchUID", Number(filter.BranchUID));
    const statuses = ([] as unknown[])
      .concat(Array.isArray(filter.StatusList) ? filter.StatusList : [])
      .map((status) => String(status).trim())
      .filter(Boolean);
    if (statuses.length > 0) {
      query.whereIn("r.DocStatus", statuses);
    } else {
      const status = filter.Status ?? "All";
      if (status && status !== "All") query.where("r.DocStatus", status);
      else if (spec.allHidesCancelled) query.whereNot("r.DocStatus", "Cancelled");
    }
    if (filter.DateFrom) query.where(`r.${spec.dateColumn}`, ">=", filter.DateFrom);
    if (filter.DateTo) query.where(`r.${spec.dateColumn}`, "<=", filter.DateTo);
    if (filter.Name) this.whereAnyLike(query, [`r.${spec.numberColumn}`, "c.CategoryName", "r.Notes"], String(filter.Name));
    const categories = spec.filtersByCategory ? intList(filter.CategoryUIDs) : [];
    if (categories.length > 0) query.whereIn("r.CategoryUID", categories);
    const paymentTypes = intList(filter.PaymentTypeUIDs);
    if (paymentTypes.length > 0) {
      query.whereExists((sub) =>
        sub
          .select(this.read.raw("1"))
          .from("Transaction.PaymentsTbl as _py")
          .whereRaw(`_py.TransUID = r.${spec.uidColumn}`)
          .where({ "_py.SourceType": spec.sourceType, "_py.IsDeleted": 0 })
          .whereIn("_py.PaymentTypeUID", paymentTypes)
      );
    }
    const updatedBy = intList(filter.UpdatedByUIDs);
    if (updatedBy.length > 0) query.whereIn("r.UpdatedBy", updatedBy);
    return query;
  }
}
