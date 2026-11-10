import { Injectable } from "@nestjs/common";
import { phpDate, phpRound } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postValue } from "../../core/utils/form-values";
import { JournalService } from "../../libraries/journal/journal.service";
import { RentalFilter, RentalRepository } from "./rental.repository";

type Form = Record<string, unknown>;
type Row = Record<string, unknown>;

const MODULE_UID = 116;
const DEC = 2; // CI3 MY_Controller::_decimals
const RENTAL_TYPES = ["Hourly", "HalfDay", "FullDay", "Fixed"];
const DATE_TIME = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;

const num = (value: unknown) => Number(value ?? 0) || 0;
const money = (value: unknown) => phpRound(num(value), DEC);
const text = (form: Form, key: string) => {
  const value = postValue(form, key);
  return value === null ? null : String(value).trim() || null;
};

// A posted date / date-time as MySQL DATETIME ('2026-11-10T10:30' → '2026-11-10 10:30:00'); invalid → null
function dateTime(value: string | null): string | null {
  if (!value || !DATE_TIME.test(value) || Number.isNaN(Date.parse(value.replace(" ", "T")))) return null;
  const [date, time = "00:00:00"] = value.replace("T", " ").split(" ");
  return `${date} ${time.length === 5 ? `${time}:00` : time}`;
}

// The list filter posted as JSON or Filter[...]; CI3's default is every status
function filterOf(value: unknown): RentalFilter {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = {};
    }
  }
  const f = raw && typeof raw === "object" ? (raw as Row) : {};
  return { Status: typeof f.Status === "string" && f.Status ? f.Status : "All", Search: typeof f.Search === "string" ? f.Search.trim() : undefined };
}

/** CI3 Rental controller (module 116): rentals of machines / equipment to customers, their returns and payments. */
@Injectable()
export class RentalService {
  constructor(
    private readonly db: DatabaseService,
    private readonly repo: RentalRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly journal: JournalService
  ) {}

  // index — page 1 of every status, stats, payment types and bank accounts
  async pageData(orgUID: number, rowLimit: number | undefined) {
    const [page, types, banks] = await Promise.all([this.page(orgUID, 1, rowLimit, { Status: "All" }), this.repo.paymentTypes(), this.repo.bankAccounts(orgUID)]);
    return { ...page, PaymentTypes: types, BankAccounts: banks };
  }

  // getPageDetails — { Data (each with Machines), TotalCount, PageNo, RowLimit, Stats }
  async page(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: RentalFilter) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const page = Math.max(1, pageNo);
    const [rows, total, stats] = await Promise.all([this.repo.list(orgUID, filter, limit, (page - 1) * limit), this.repo.count(orgUID, filter), this.repo.stats(orgUID)]);
    return { Data: rows, TotalCount: total, PageNo: page, RowLimit: limit, Stats: stats };
  }

  listFilter = filterOf;

  async detail(orgUID: number, rentalUID: number) {
    if (rentalUID <= 0) throw new CiValidationError("Invalid rental record.");
    const rental = await this.repo.rental(orgUID, rentalUID);
    if (!rental) throw new CiValidationError("Rental not found.");
    return { Data: rental };
  }

  async searchProducts(orgUID: number, term: string) {
    await this.orgSettings.get(orgUID);
    return { Products: await this.repo.searchRentable(orgUID, term.trim()) };
  }

  /**
   * createRental — the rental (RNT-<id>), its machines (Items JSON) and the deposit collected on booking. Customer,
   * machines, payment type and bank account must be the org's (CI3 took any UID).
   */
  async create(ctx: WriteContext, form: Form) {
    const tz = (await this.orgSettings.get(ctx.orgUID)).Timezone;
    const customerUID = postInt(form, "CustomerUID");
    const startText = text(form, "RentalStartDateTime");
    const start = startText ? dateTime(startText) : phpDate("Y-m-d H:i:s", new Date(), tz);
    const dueText = text(form, "ReturnDueDateTime");
    const deposit = money(postValue(form, "DepositCollected"));
    const depositPayType = postInt(form, "DepositPaymentTypeUID") || null;
    const depositBank = postInt(form, "DepositBankAccountUID") || null;
    const notes = text(form, "Notes");
    const items = RentalService.items(form.Items);

    if (customerUID <= 0) throw new CiValidationError("Please select a customer.");
    if (!dueText) throw new CiValidationError("Return due date/time is required.");
    if (items.length === 0) throw new CiValidationError("Please add at least one machine.");
    const due = dateTime(dueText);
    if (!start || !due) throw new CiValidationError("Rental start and return due must be valid dates.");
    if (deposit < 0) throw new CiValidationError("Deposit collected cannot be negative.");
    if (!(await this.repo.customerExists(ctx.orgUID, customerUID))) throw new CiValidationError("Customer not found.");
    const productUIDs = [...new Set(items.map((i) => parseInt(String(i.ProductUID ?? ""), 10)).filter((n) => n > 0))];
    const rentable = await this.repo.searchRentable(ctx.orgUID, "", productUIDs);
    if (productUIDs.length === 0 || rentable.length !== productUIDs.length || items.some((i) => !(parseInt(String(i.ProductUID ?? ""), 10) > 0))) {
      throw new CiValidationError("A machine is not a rentable product of this organisation.");
    }
    if (deposit > 0) await this.assertPayment(ctx.orgUID, depositPayType, depositBank, false);

    let totalRental = 0;
    let totalDeposit = 0;
    for (const item of items) {
      const qty = Math.max(1, Math.trunc(num(item.Qty)) || 1);
      totalRental += num(item.BaseRentalCharge) * qty;
      totalDeposit += num(item.SecurityDeposit) * qty;
    }

    const { rentalUID, rentalNumber } = await this.db.write.transaction(async (trx) => {
      const uid = await this.repo.insert(trx, "RentalMasterTbl", {
        OrgUID: ctx.orgUID,
        ModuleUID: MODULE_UID,
        CustomerUID: customerUID,
        RentalStartDateTime: start,
        ReturnDueDateTime: due,
        RentalStatus: "Active",
        PaymentStatus: deposit > 0 ? "AdvancePaid" : "Unpaid",
        TotalRentalAmount: money(totalRental),
        ExtraCharges: 0,
        GrandTotal: money(totalRental),
        DepositAmount: money(totalDeposit),
        DepositCollected: deposit,
        DepositRefunded: 0,
        TotalPaid: deposit,
        BalanceAmount: money(totalRental - deposit),
        Notes: notes,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: ctx.userUID,
        UpdatedBy: ctx.userUID,
      });
      const number = `RNT-${String(uid).padStart(4, "0")}`;
      await this.repo.updateRental(trx, ctx.orgUID, uid, { RentalNumber: number });

      for (const item of items) {
        const qty = Math.max(1, Math.trunc(num(item.Qty)) || 1);
        const charge = money(num(item.BaseRentalCharge) * qty);
        await this.repo.insert(trx, "RentalItemsTbl", {
          RentalUID: uid,
          ProductUID: parseInt(String(item.ProductUID), 10),
          Qty: qty,
          RentalType: RENTAL_TYPES.includes(String(item.RentalType)) ? item.RentalType : "Hourly",
          SecurityDeposit: money(item.SecurityDeposit),
          HourlyRate: money(item.HourlyRate),
          HalfDayRate: money(item.HalfDayRate),
          FullDayRate: money(item.FullDayRate),
          FixedPackageRate: money(item.FixedPackageRate),
          ExtraHourRate: money(item.ExtraHourRate),
          LateReturnChargePerHour: money(item.LateReturnChargePerHour),
          BaseRentalCharge: charge,
          ReturnedQty: 0,
          DamagedQty: 0,
          TotalCharge: charge,
          ItemStatus: "Rented",
          IsActive: 1,
          IsDeleted: 0,
          CreatedBy: ctx.userUID,
          UpdatedBy: ctx.userUID,
        });
      }

      if (deposit > 0) {
        await this.repo.insert(trx, "RentalPaymentsTbl", {
          RentalUID: uid,
          OrgUID: ctx.orgUID,
          PaymentType: "Deposit",
          Amount: deposit,
          PaymentDate: String(start).slice(0, 10),
          PaymentTypeUID: depositPayType,
          BankAccountUID: depositBank,
          Notes: "Security deposit collected on booking",
          IsActive: 1,
          IsDeleted: 0,
          CreatedBy: ctx.userUID,
          UpdatedBy: ctx.userUID,
        });
      }
      return { rentalUID: uid, rentalNumber: number };
    });

    return { Message: `${rentalNumber} created successfully.`, RentalUID: rentalUID, RentalNumber: rentalNumber, ...(await this.refreshed(ctx.orgUID, form)) };
  }

  /**
   * processReturn — one machine back, with its extra-hour, late and damage charges added to the rental. The rental
   * is Closed once every machine is back, otherwise PartiallyReturned. A machine already returned cannot be returned
   * again (CI3 added its charges a second time).
   */
  async processReturn(ctx: WriteContext, form: Form) {
    const tz = (await this.orgSettings.get(ctx.orgUID)).Timezone;
    const rentalUID = postInt(form, "RentalUID");
    const itemUID = postInt(form, "RentalItemUID");
    const returnedQty = postInt(form, "ReturnedQty");
    const damagedQty = Math.max(0, postInt(form, "DamagedQty"));
    const returnText = text(form, "ActualReturnDateTime");
    const actualReturn = returnText ? dateTime(returnText) : phpDate("Y-m-d H:i:s", new Date(), tz);
    const hours = Math.max(0, num(postValue(form, "ActualHours")));
    const extraHour = money(postValue(form, "ExtraHourCharge"));
    const late = money(postValue(form, "LateReturnCharge"));
    const damage = money(postValue(form, "DamageCharge"));
    const notes = text(form, "ReturnNotes");

    if (rentalUID <= 0) throw new CiValidationError("Invalid rental record.");
    if (itemUID <= 0) throw new CiValidationError("Invalid rental item.");
    if (returnedQty <= 0) throw new CiValidationError("Returned quantity must be greater than zero.");
    if (!actualReturn) throw new CiValidationError("Actual return date/time is not valid.");
    if (extraHour < 0 || late < 0 || damage < 0) throw new CiValidationError("Charges cannot be negative.");

    const status = await this.db.write.transaction(async (trx) => {
      const rental = await this.repo.rental(ctx.orgUID, rentalUID, trx);
      if (!rental) throw new CiValidationError("Rental not found.");
      if (["Closed", "Cancelled"].includes(String(rental.RentalStatus))) throw new CiValidationError(`This rental is already ${rental.RentalStatus}.`);
      const items = rental.Items as Row[];
      const item = items.find((i) => Number(i.RentalItemUID) === itemUID);
      if (!item) throw new CiValidationError("Invalid rental item.");
      if (item.ItemStatus === "Returned") throw new CiValidationError("This machine has already been returned.");
      if (returnedQty > num(item.Qty)) throw new CiValidationError(`Returned quantity cannot be more than the ${num(item.Qty)} rented.`);
      if (damagedQty > returnedQty) throw new CiValidationError("Damaged quantity cannot be more than the returned quantity.");

      const totalForReturn = money(extraHour + late + damage);
      await this.repo.updateItem(trx, rentalUID, itemUID, {
        ReturnedQty: returnedQty,
        DamagedQty: damagedQty,
        ActualReturnDateTime: actualReturn,
        ActualHours: hours,
        ExtraHourCharge: extraHour,
        LateReturnCharge: late,
        DamageCharge: damage,
        ItemStatus: "Returned",
        ReturnNotes: notes,
        UpdatedBy: ctx.userUID,
      });
      await this.repo.insert(trx, "RentalReturnsTbl", {
        RentalUID: rentalUID,
        RentalItemUID: itemUID,
        OrgUID: ctx.orgUID,
        ReturnedQty: returnedQty,
        DamagedQty: damagedQty,
        ActualReturnDateTime: actualReturn,
        ActualHours: hours,
        BaseRentalCharge: 0,
        ExtraHourCharge: extraHour,
        LateReturnCharge: late,
        DamageCharge: damage,
        TotalChargeForReturn: totalForReturn,
        Notes: notes,
        CreatedBy: ctx.userUID,
        UpdatedBy: ctx.userUID,
      });

      const extraCharges = money(num(rental.ExtraCharges) + totalForReturn);
      const grandTotal = money(num(rental.TotalRentalAmount) + extraCharges);
      const balance = money(grandTotal - num(rental.TotalPaid));
      const allDone = items.every((i) => Number(i.RentalItemUID) === itemUID || i.ItemStatus === "Returned");
      const newStatus = allDone ? "Closed" : "PartiallyReturned";
      await this.repo.updateRental(trx, ctx.orgUID, rentalUID, {
        ExtraCharges: extraCharges,
        GrandTotal: grandTotal,
        BalanceAmount: balance,
        RentalStatus: newStatus,
        ActualReturnDateTime: allDone ? actualReturn : null,
        UpdatedBy: ctx.userUID,
      });
      return newStatus;
    });

    return { Message: `Return recorded. Status: ${status}.`, ...(await this.refreshed(ctx.orgUID, form)) };
  }

  /**
   * recordPayment — a rental charge received (TransUID is the RentalUID, as the shared payment modal sends it), then
   * its income journal (Dr Accounts Receivable, Cr Indirect Income; reference RentalPayment / the payment's UID),
   * which as in CI3 does not stop the payment.
   */
  async recordPayment(ctx: WriteContext, form: Form) {
    const tz = (await this.orgSettings.get(ctx.orgUID)).Timezone;
    const rentalUID = postInt(form, "TransUID");
    const paymentTypeUID = postInt(form, "PaymentTypeUID") || null;
    const bankAccountUID = postInt(form, "BankAccountUID") || null;
    const dateText = text(form, "PaymentDate");
    const paymentDate = dateText ? dateTime(dateText)?.slice(0, 10) ?? null : phpDate("Y-m-d", new Date(), tz);
    const amount = money(postValue(form, "Amount"));
    const referenceNo = text(form, "ReferenceNo");
    const notes = text(form, "Notes");

    if (rentalUID <= 0) throw new CiValidationError("Invalid rental record.");
    if (!paymentTypeUID) throw new CiValidationError("Please select a payment method.");
    if (amount <= 0) throw new CiValidationError("Amount must be greater than zero.");
    if (!paymentDate) throw new CiValidationError("Payment date is not valid.");
    await this.assertPayment(ctx.orgUID, paymentTypeUID, bankAccountUID, true);

    const { paymentUID, rentalNumber } = await this.db.write.transaction(async (trx) => {
      const rental = await this.repo.rental(ctx.orgUID, rentalUID, trx);
      if (!rental) throw new CiValidationError("Rental not found.");
      const uid = await this.repo.insert(trx, "RentalPaymentsTbl", {
        RentalUID: rentalUID,
        OrgUID: ctx.orgUID,
        PaymentType: "RentalCharge",
        Amount: amount,
        PaymentDate: paymentDate,
        PaymentTypeUID: paymentTypeUID,
        BankAccountUID: bankAccountUID,
        ReferenceNo: referenceNo ? referenceNo.slice(0, 100) : null,
        Notes: notes,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: ctx.userUID,
        UpdatedBy: ctx.userUID,
      });
      const totalPaid = money(num(rental.TotalPaid) + amount);
      const balance = money(num(rental.GrandTotal) - totalPaid);
      await this.repo.updateRental(trx, ctx.orgUID, rentalUID, {
        TotalPaid: totalPaid,
        BalanceAmount: balance,
        PaymentStatus: balance <= 0 ? "Paid" : totalPaid > 0 ? "PartiallyPaid" : "Unpaid",
        UpdatedBy: ctx.userUID,
      });
      return { paymentUID: uid, rentalNumber: String(rental.RentalNumber || `RNT-${rentalUID}`) };
    });

    await this.journal.postAfterSave(`Rental payment ${paymentUID}`, (trx) =>
      this.journal.postIndirectIncome(trx, { orgUID: ctx.orgUID, recordUID: paymentUID, number: rentalNumber, date: paymentDate, netAmount: amount, userUID: ctx.userUID }, "RentalPayment")
    );
    return { Message: "Payment recorded successfully.", ...(await this.refreshed(ctx.orgUID, form)) };
  }

  async cancel(ctx: WriteContext, form: Form) {
    const rentalUID = postInt(form, "RentalUID");
    if (rentalUID <= 0) throw new CiValidationError("Invalid rental record.");
    const rental = await this.repo.rental(ctx.orgUID, rentalUID);
    if (!rental) throw new CiValidationError("Rental not found.");
    if (["Closed", "Cancelled"].includes(String(rental.RentalStatus))) throw new CiValidationError("This rental cannot be cancelled.");
    await this.repo.updateRental(null, ctx.orgUID, rentalUID, { RentalStatus: "Cancelled", UpdatedBy: ctx.userUID });
    return { Message: `${rental.RentalNumber || "Rental"} cancelled.`, ...(await this.refreshed(ctx.orgUID, form)) };
  }

  private async assertPayment(orgUID: number, paymentTypeUID: number | null, bankAccountUID: number | null, required: boolean): Promise<void> {
    if (paymentTypeUID && !(await this.repo.paymentTypeExists(paymentTypeUID))) throw new CiValidationError("Payment method not found.");
    if (required && !paymentTypeUID) throw new CiValidationError("Please select a payment method.");
    if (bankAccountUID && !(await this.repo.bankAccountExists(orgUID, bankAccountUID))) throw new CiValidationError("Bank account not found.");
  }

  // _appendListResponse — page 1 of the posted filter (CI3 always answered with page 1)
  private async refreshed(orgUID: number, form: Form) {
    const page = await this.page(orgUID, 1, postInt(form, "RowLimit") || undefined, filterOf(form.Filter));
    return { Data: page.Data, TotalCount: page.TotalCount, PageNo: page.PageNo, RowLimit: page.RowLimit, Stats: page.Stats };
  }

  // Items posted as a JSON string (as the CI3 page sends them) or an array
  private static items(value: unknown): Row[] {
    let raw: unknown = value;
    if (typeof value === "string") {
      try {
        raw = JSON.parse(value);
      } catch {
        return [];
      }
    }
    if (Array.isArray(raw)) return raw.filter((i) => i && typeof i === "object") as Row[];
    if (raw && typeof raw === "object") return Object.values(raw as Row).filter((i) => i && typeof i === "object") as Row[];
    return [];
  }
}
