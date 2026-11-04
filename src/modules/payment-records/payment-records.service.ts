import { Injectable } from "@nestjs/common";
import { phpRound } from "../../common/utils/php-compat";
import { AMOUNT_DECIMALS } from "../../core/constants";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { CiValidationError } from "../../core/response/ci-response";
import { buildDateRange } from "../../core/utils/date-range";
import { PaymentFilter, PaymentRecordsRepository } from "./payment-records.repository";

// Users.UserPreferencesTbl key of the page's saved date filter (CI3 getDateFilterPreference('payments'))
const DATE_PREFERENCE = "df_payments";

const sumOf = (rows: Record<string, unknown>[], column: string) => phpRound(rows.reduce((total, row) => total + Number(row[column] ?? 0), 0), AMOUNT_DECIMALS);

/** Payments page reads (CI3 Payments controller, module 110): money in and out of every module in one list. */
@Injectable()
export class PaymentRecordsService {
  constructor(
    private readonly repo: PaymentRecordsRepository,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // index — dropdowns, filter users, cash / bank stats and the saved date range (default this month)
  async getPageData(orgUID: number, branchUID: number, userUID: number) {
    const [settings, print, saved, banks, types, users] = await Promise.all([
      this.orgSettings.get(orgUID),
      this.repo.printSettings(orgUID),
      this.repo.preference(orgUID, branchUID, userUID, DATE_PREFERENCE),
      this.repo.bankAccounts(orgUID),
      this.repo.paymentTypes(),
      this.repo.orgUsers(orgUID),
    ]);
    const range = buildDateRange(saved || "this_month", settings.Timezone);
    return {
      ShowStats: print.showStats,
      BalanceStats: print.showStats ? await this.repo.balanceStats(orgUID, {}) : null,
      BankAccounts: banks,
      PaymentTypes: types,
      OrgUsers: users,
      RowLimit: settings.RowLimit,
      SavedDateRange: range.range,
      SavedDateLabel: range.label,
      SavedDateFrom: range.from,
      SavedDateTo: range.to,
      InitFilter: { DateFrom: range.from, DateTo: range.to },
    };
  }

  // getPaymentsPageDetails — the CI3 JS builds the rows from Data
  async getPage(orgUID: number, pageNo: number, rowLimit: number | undefined, filter: PaymentFilter) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const [rows, total] = await Promise.all([this.repo.list(orgUID, filter, limit, (pageNo - 1) * limit), this.repo.count(orgUID, filter)]);
    return { Data: rows, TotalCount: total, PageNo: pageNo, RowLimit: limit };
  }

  // getStats — only when the organisation shows stats
  async getStats(orgUID: number, filter: PaymentFilter) {
    const { showStats } = await this.repo.printSettings(orgUID);
    return showStats ? { Stats: await this.repo.balanceStats(orgUID, filter) } : {};
  }

  // getPaymentsByTransaction — a transaction's payments and their total
  async getByTransaction(orgUID: number, transUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid transaction.");
    const payments = await this.repo.ofTransaction(orgUID, transUID);
    return { Payments: payments, PaidTotal: payments.reduce((total, payment) => total + Number(payment.Amount ?? 0), 0) };
  }

  // getPaymentDetail
  async getDetail(orgUID: number, paymentUID: number) {
    if (paymentUID <= 0) throw new CiValidationError("Invalid payment record.");
    const record = await this.repo.detail(orgUID, paymentUID);
    if (!record) throw new CiValidationError("Payment record not found.");
    return { Data: record };
  }

  // getCustomerCreditsDetail — on-account credits and advances, with their totals
  async getCustomerCredits(orgUID: number, customerUID: number) {
    if (customerUID <= 0) throw new CiValidationError("Invalid customer.");
    const rows = await this.repo.customerCredits(orgUID, customerUID);
    const onAccount = rows.filter((row) => row.CreditType === "on_account");
    const advance = rows.filter((row) => row.CreditType !== "on_account");
    return { OnAccount: onAccount, Advance: advance, OnAccountTotal: sumOf(onAccount, "Amount"), AdvanceTotal: sumOf(advance, "Amount") };
  }

  // getCustomerCreditNoteDetail — pending credit notes and their total
  async getCustomerCreditNotes(orgUID: number, customerUID: number) {
    if (customerUID <= 0) throw new CiValidationError("Invalid customer.");
    const rows = await this.repo.pendingCreditNotes(orgUID, customerUID);
    return { CreditNotes: rows, Total: sumOf(rows, "Amount") };
  }

  // getCustomerExcessBalance — credit sources for the payment modal and their total
  async getCustomerExcessBalance(orgUID: number, customerUID: number) {
    if (customerUID <= 0) throw new CiValidationError("Invalid customer.");
    const rows = await this.repo.availableCredits(orgUID, customerUID);
    return { TotalCredit: sumOf(rows, "CreditAmount"), Sources: rows };
  }

  // getPaymentTypes
  async getPaymentTypes() {
    return { Data: await this.repo.paymentTypes() };
  }

  // getBankAccounts / getBanksList
  async getBankAccounts(orgUID: number) {
    return { Data: await this.repo.bankAccounts(orgUID) };
  }

  // getBankDetails
  async getBankDetails(orgUID: number, bankAccountUID: number) {
    if (bankAccountUID <= 0) throw new CiValidationError("Bank account ID is required.");
    const record = await this.repo.bankAccount(orgUID, bankAccountUID);
    if (!record) throw new CiValidationError("Bank account not found.");
    return { Data: record };
  }
}
