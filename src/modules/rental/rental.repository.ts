import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;
export interface RentalFilter {
  Status?: string;
  Search?: string;
}

const ITEM_COLUMNS = [
  "ri.RentalUID",
  "ri.RentalItemUID",
  "p.ItemName",
  "ri.ProductUID",
  "ri.Qty",
  "ri.RentalType",
  "ri.BaseRentalCharge",
  "ri.TotalCharge",
  "ri.ItemStatus",
  "ri.HourlyRate",
  "ri.HalfDayRate",
  "ri.FullDayRate",
  "ri.FixedPackageRate",
  "ri.ExtraHourRate",
  "ri.LateReturnChargePerHour",
  "ri.SecurityDeposit",
  "ri.ReturnedQty",
  "ri.DamagedQty",
  "ri.ActualReturnDateTime",
  "ri.ActualHours",
  "ri.ExtraHourCharge",
  "ri.LateReturnCharge",
  "ri.DamageCharge",
];

const MASTER_COLUMNS = [
  "r.RentalUID",
  "r.OrgUID",
  "r.ModuleUID",
  "r.RentalNumber",
  "r.CustomerUID",
  "r.RentalStartDateTime",
  "r.ReturnDueDateTime",
  "r.ActualReturnDateTime",
  "r.RentalStatus",
  "r.PaymentStatus",
  "r.TotalRentalAmount",
  "r.ExtraCharges",
  "r.GrandTotal",
  "r.DepositAmount",
  "r.DepositCollected",
  "r.DepositRefunded",
  "r.TotalPaid",
  "r.BalanceAmount",
  "r.Notes",
  "r.CreatedBy",
  "r.UpdatedBy",
  "r.CreatedOn",
  "r.UpdatedOn",
];

/** Rental_model: machine / equipment rentals, their items, returns and payments. */
@Injectable()
export class RentalRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getRentalStats
  async stats(orgUID: number): Promise<Row> {
    const row = await this.read("Transaction.RentalMasterTbl as r")
      .select(
        this.read.raw(`COUNT(*) AS totalCount,
          IFNULL(SUM(CASE WHEN r.RentalStatus IN ('Active','PartiallyReturned','Overdue') THEN 1 ELSE 0 END), 0) AS activeCount,
          IFNULL(SUM(CASE WHEN r.RentalStatus = 'Overdue' THEN 1 ELSE 0 END), 0) AS overdueCount,
          IFNULL(SUM(CASE WHEN r.RentalStatus = 'Closed' THEN 1 ELSE 0 END), 0) AS closedCount,
          SUM(r.GrandTotal) AS totalRevenue,
          SUM(r.BalanceAmount) AS totalBalance,
          SUM(r.DepositCollected) AS totalDeposit`)
      )
      .where({ "r.OrgUID": orgUID, "r.IsDeleted": 0 })
      .first();
    return (row as Row | undefined) ?? {};
  }

  private listBase(orgUID: number, filter: RentalFilter): Knex.QueryBuilder {
    const qb = this.read("Transaction.RentalMasterTbl as r")
      .leftJoin("Customers.CustomerTbl as c", (on) => on.on("c.CustomerUID", "r.CustomerUID").andOnVal("c.IsDeleted", "=", 0))
      .where({ "r.OrgUID": orgUID, "r.IsDeleted": 0 });
    if (filter.Status && filter.Status !== "All") {
      if (filter.Status === "Active") qb.whereIn("r.RentalStatus", ["Active", "PartiallyReturned", "Overdue"]);
      else qb.where("r.RentalStatus", filter.Status);
    }
    if (filter.Search) this.whereAnyLike(qb, ["r.RentalNumber", "c.Name", "c.MobileNumber"], filter.Search);
    return qb;
  }

  // getRentalList — with each rental's machines (one query for the page, CI3 ran one per rental)
  async list(orgUID: number, filter: RentalFilter, limit: number, offset: number): Promise<Row[]> {
    const rows: Row[] = await this.listBase(orgUID, filter)
      .select(
        "r.RentalUID",
        "r.RentalNumber",
        "r.RentalStartDateTime",
        "r.ReturnDueDateTime",
        "r.ActualReturnDateTime",
        "r.RentalStatus",
        "r.PaymentStatus",
        "r.TotalRentalAmount",
        "r.ExtraCharges",
        "r.GrandTotal",
        "r.TotalPaid",
        "r.BalanceAmount",
        "r.DepositCollected",
        "r.Notes",
        "r.UpdatedOn",
        "r.CustomerUID",
        "c.Name as CustomerName",
        "c.MobileNumber as CustomerMobile",
        "c.Area as PartyArea",
        "c.CountryCode",
        "c.EmailAddress",
        "c.Image as PartyImage"
      )
      .orderBy("r.RentalUID", "desc")
      .limit(limit)
      .offset(offset);
    const items = await this.items(rows.map((r) => Number(r.RentalUID)));
    for (const row of rows) row.Machines = items.filter((i) => Number(i.RentalUID) === Number(row.RentalUID));
    return rows;
  }

  async count(orgUID: number, filter: RentalFilter): Promise<number> {
    const row = await this.listBase(orgUID, filter).count({ cnt: "*" }).first();
    return Number(row?.cnt ?? 0);
  }

  // _getMachineSummary — the live items of these rentals
  async items(rentalUIDs: number[], trx?: Knex.Transaction): Promise<Row[]> {
    if (rentalUIDs.length === 0) return [];
    return (trx ?? this.read)("Transaction.RentalItemsTbl as ri")
      .select(ITEM_COLUMNS)
      .join("Products.ProductTbl as p", (on) => on.on("p.ProductUID", "ri.ProductUID").andOnVal("p.IsDeleted", "=", 0))
      .whereIn("ri.RentalUID", rentalUIDs)
      .where("ri.IsDeleted", 0)
      .orderBy("ri.RentalItemUID", "asc");
  }

  // getRentalById — with its items and payments
  async rental(orgUID: number, rentalUID: number, trx?: Knex.Transaction): Promise<Row | null> {
    const qb = (trx ?? this.read)("Transaction.RentalMasterTbl as r")
      .select(MASTER_COLUMNS)
      .select("c.Name as CustomerName", "c.MobileNumber as CustomerMobile", "c.EmailAddress as CustomerEmail")
      .leftJoin("Customers.CustomerTbl as c", (on) => on.on("c.CustomerUID", "r.CustomerUID").andOnVal("c.IsDeleted", "=", 0))
      .where({ "r.RentalUID": rentalUID, "r.OrgUID": orgUID, "r.IsDeleted": 0 });
    if (trx) qb.forUpdate();
    const rental = (await qb.first()) as Row | undefined;
    if (!rental) return null;
    rental.Items = await this.items([rentalUID], trx);
    rental.Payments = await this.payments(orgUID, rentalUID, trx);
    return rental;
  }

  // getRentalPayments
  payments(orgUID: number, rentalUID: number, trx?: Knex.Transaction): Promise<Row[]> {
    return (trx ?? this.read)("Transaction.RentalPaymentsTbl as rp")
      .select(
        "rp.RentalPaymentUID",
        "rp.RentalUID",
        "rp.OrgUID",
        "rp.PaymentType",
        "rp.Amount",
        this.read.raw("DATE_FORMAT(??, '%Y-%m-%d') AS ??", ["rp.PaymentDate", "PaymentDate"]),
        "rp.PaymentTypeUID",
        "rp.BankAccountUID",
        "rp.ReferenceNo",
        "rp.Notes",
        "rp.CreatedOn",
        "pt.Name as PaymentTypeName"
      )
      .leftJoin("Global.PaymentTypesTbl as pt", "pt.PaymentTypeUID", "rp.PaymentTypeUID")
      .where({ "rp.RentalUID": rentalUID, "rp.OrgUID": orgUID, "rp.IsDeleted": 0 })
      .orderBy("rp.RentalPaymentUID", "asc");
  }

  // searchRentableProducts — the org's active rentable products with their rental rates (50 at most)
  searchRentable(orgUID: number, term: string, productUIDs?: number[]): Promise<Row[]> {
    const qb = this.read("Products.ProductTbl as p")
      .select(
        "p.ProductUID",
        "p.ItemName",
        "p.PartNumber",
        this.read.raw("COALESCE(??, 0) AS ??", ["ps.AvailableQty", "AvailableQuantity"]),
        "rc.SecurityDeposit",
        "rc.HourlyRate",
        "rc.HalfDayRate",
        "rc.FullDayRate",
        "rc.FixedPackageRate",
        "rc.ExtraHourRate",
        "rc.LateReturnChargePerHour",
        "rc.MinRentalHours"
      )
      .leftJoin("Products.ProductStockTbl as ps", "ps.ProductUID", "p.ProductUID")
      .leftJoin("Products.ProductRentalConfigTbl as rc", (on) => on.on("rc.ProductUID", "p.ProductUID").andOn("rc.OrgUID", "p.OrgUID").andOnVal("rc.IsDeleted", "=", 0))
      .where({ "p.OrgUID": orgUID, "p.IsDeleted": 0, "p.IsActive": 1, "p.IsRentable": 1 });
    if (productUIDs) qb.whereIn("p.ProductUID", productUIDs);
    if (term) this.whereAnyLike(qb, ["p.ItemName", "p.PartNumber"], term);
    return qb.orderBy("p.ItemName", "asc").limit(productUIDs ? productUIDs.length || 1 : 50);
  }

  // getPaymentTypes
  paymentTypes(): Promise<Row[]> {
    return this.read("Global.PaymentTypesTbl").select("PaymentTypeUID", "Name as PaymentTypeName", "IsCash").where("IsActive", 1).orderBy("PaymentTypeUID", "asc");
  }

  // getBankAccounts — the org's active bank (not cash) accounts
  bankAccounts(orgUID: number): Promise<Row[]> {
    return this.read("Organisation.OrgBankAccountsTbl")
      .select("BankAccountUID", "AccountName", "BankName", "IsDefault")
      .where({ OrgUID: orgUID, IsCash: 0, IsDeleted: 0, IsActive: 1 })
      .orderBy("IsDefault", "desc");
  }

  async customerExists(orgUID: number, customerUID: number): Promise<boolean> {
    return !!(await this.read("Customers.CustomerTbl").select("CustomerUID").where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 }).first());
  }

  async paymentTypeExists(paymentTypeUID: number): Promise<boolean> {
    return !!(await this.read("Global.PaymentTypesTbl").select("PaymentTypeUID").where({ PaymentTypeUID: paymentTypeUID, IsActive: 1 }).first());
  }

  async bankAccountExists(orgUID: number, bankAccountUID: number): Promise<boolean> {
    return !!(await this.read("Organisation.OrgBankAccountsTbl").select("BankAccountUID").where({ BankAccountUID: bankAccountUID, OrgUID: orgUID, IsDeleted: 0 }).first());
  }

  async insert(trx: Knex.Transaction, table: "RentalMasterTbl" | "RentalItemsTbl" | "RentalPaymentsTbl" | "RentalReturnsTbl", row: Row): Promise<number> {
    const [id] = await trx(`Transaction.${table}`).insert(row);
    return Number(id);
  }

  updateRental(trx: Knex.Transaction | null, orgUID: number, rentalUID: number, data: Row): Promise<number> {
    return (trx ?? this.db.write)("Transaction.RentalMasterTbl").where({ RentalUID: rentalUID, OrgUID: orgUID, IsDeleted: 0 }).update(data);
  }

  updateItem(trx: Knex.Transaction, rentalUID: number, rentalItemUID: number, data: Row): Promise<number> {
    return trx("Transaction.RentalItemsTbl").where({ RentalItemUID: rentalItemUID, RentalUID: rentalUID, IsDeleted: 0 }).update(data);
  }
}
