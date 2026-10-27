import { Injectable } from "@nestjs/common";
import { BALANCE_FY_START_MONTH } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { currentFinancialYear } from "../../core/utils/financial-year";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { CustomerBalanceService } from "../../libraries/customer-balance/customer-balance.service";
import { TransactionPaymentService } from "../../libraries/transaction-payment/transaction-payment.service";
import { CustomerCacheService } from "./customer-cache.service";
import { ApplyOnAccountDto, CustomerIdDto, CustomerOpeningBalanceSaveDto } from "./dto/customer-write.dto";
import { CustomersRepository } from "./customers.repository";

/** Customer balance writes (CI3 Customers: opening balance, balance recalculation, on-account payments). */
@Injectable()
export class CustomerAccountService {
  constructor(
    private readonly db: DatabaseService,
    private readonly customers: CustomersRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly customerBalance: CustomerBalanceService,
    private readonly payments: TransactionPaymentService,
    private readonly cache: CustomerCacheService,
    private readonly audit: AuditLogService
  ) {}

  // saveCustomerOpeningBalance — opening balance row and the year snapshot (the closing balance is not recalculated, as in CI3).
  async saveOpeningBalance(dto: CustomerOpeningBalanceSaveDto, ctx: WriteContext) {
    const customerUID = postInt(dto, "CustomerUID");
    const balance = Number(postValue(dto, "OpeningBalance", 0)) || 0;
    const balanceType = (postString(dto, "BalanceType") ?? "").trim();
    const notes = (postString(dto, "Notes") ?? "").trim();
    const requestedYear = postInt(dto, "FinancialYear");
    if (customerUID <= 0) throw new CiValidationError("Invalid customer.");
    if (balance < 0) throw new CiValidationError("Opening balance cannot be negative.");
    if (balanceType !== "Debit" && balanceType !== "Credit") throw new CiValidationError("BalanceType must be Debit or Credit.");
    await this.requireCustomer(ctx.orgUID, customerUID);
    const financialYear = requestedYear > 0 ? requestedYear : currentFinancialYear(BALANCE_FY_START_MONTH);

    const before = await this.customers.findOpeningBalance(ctx.orgUID, customerUID);
    const openingBalUID = await this.db.transaction(async (trx) => {
      const id = await this.customers.saveOpeningBalance(trx, ctx.orgUID, customerUID, balance, balanceType, notes, ctx.userUID, false);
      await this.customers.saveYearOpening(trx, ctx.orgUID, customerUID, financialYear, balance, balanceType, ctx.userUID);
      return id;
    });

    await this.refreshCache(ctx.orgUID, customerUID);
    const values = { balance, balanceType, financialYear };
    await this.audit.log(ctx, {
      action: "SET_CUSTOMER_OPENING_BALANCE",
      entityType: "Customer",
      entityUID: customerUID,
      details: values,
      summary: `Set opening balance ${balanceType} ${balance} for customer #${customerUID}`,
      module: "Customers",
      category: "MASTER",
      oldValues: before ? { balance: before.OpeningBalance, balanceType: before.OpeningBalType } : {},
      newValues: values,
    });
    return { Message: "Opening balance saved successfully.", OpeningBalUID: openingBalUID, FinancialYear: financialYear };
  }

  // updateCustomerBalance — stores the live balance (simple formula) for one customer, or all when CustomerUID is 0.
  async updateStoredBalances(dto: CustomerIdDto, ctx: WriteContext) {
    const customerUID = postInt(dto, "CustomerUID");
    const result = await this.customerBalance.storeLiveBalances(ctx.orgUID, customerUID, ctx.userUID);
    if (result.found === 0) throw new CiValidationError("No customers found to update.");

    await this.audit.log(ctx, {
      action: "RECALC_CUSTOMER_BALANCE",
      entityType: "Customer",
      entityUID: customerUID,
      details: { updated: result.updated, skipped: result.skipped, filterUID: customerUID },
      summary: `Recalculated customer balances: ${result.updated} updated, ${result.skipped} skipped`,
      module: "Customers",
      category: "MASTER",
    });
    return {
      Message: `Balance recalculated: ${result.updated} updated, ${result.skipped} skipped.`,
      Updated: result.updated,
      Skipped: result.skipped,
      ...(result.errors.length > 0 ? { Errors: result.errors } : {}),
    };
  }

  // recalcBalance — full recalculation (with credit / debit notes) for one customer, or every customer.
  async recalculate(dto: CustomerIdDto, ctx: WriteContext) {
    const customerUID = postInt(dto, "CustomerUID");
    if (customerUID > 0) {
      const result = await this.recalcAndCache(ctx, customerUID);
      if (!result) throw new CiValidationError("Customer not found or recalculation failed.");
      return { Message: "Balance recalculated successfully.", Balance: result.balance, BalanceType: result.type };
    }

    const customerUIDs = await this.customers.findAllUIDs(ctx.orgUID);
    if (customerUIDs.length === 0) throw new CiValidationError("No customers found for this organisation.");
    let success = 0;
    for (const uid of customerUIDs) {
      if (await this.recalcAndCache(ctx, uid)) success++;
    }
    const failed = customerUIDs.length - success;
    return {
      Message: `Recalculated ${success} of ${customerUIDs.length} customers.` + (failed > 0 ? ` ${failed} failed — check logs.` : ""),
      Total: customerUIDs.length,
      Success: success,
      Failed: failed,
    };
  }

  // applyOnAccountPayment — attaches an unapplied payment to an invoice, then recalculates the customer's balance.
  async applyOnAccountPayment(dto: ApplyOnAccountDto, ctx: WriteContext) {
    const paymentUID = postInt(dto, "PaymentUID");
    const transUID = postInt(dto, "TransUID");
    if (paymentUID <= 0 || transUID <= 0) throw new CiValidationError("PaymentUID and TransUID are required.");

    const payment = await this.payments.findOnAccountPayment(ctx.orgUID, paymentUID);
    if (!payment) throw new CiValidationError("On Account payment not found or already applied.");

    await this.db.transaction(async (trx) => {
      const invoice = await trx("Transaction.TransactionsTbl").select("TransUID").where({ TransUID: transUID, OrgUID: ctx.orgUID, IsDeleted: 0 }).first();
      if (!invoice) throw new CiValidationError("Invoice not found.");
      await this.payments.applyOnAccount(trx, ctx.orgUID, paymentUID, transUID, ctx.userUID);
      await this.payments.refreshPaidStatus(trx, ctx.orgUID, transUID, ctx.userUID);
    });

    const result = await this.recalcAndCache(ctx, Number(payment.PartyUID));
    return {
      Message: "On Account payment applied successfully.",
      ...(result ? { CustomerBalance: result.balance, CustomerBalanceType: result.type } : {}),
    };
  }

  // recalcAndSync + cache refresh (CI3 recalcAndSync refreshes the cache itself)
  private async recalcAndCache(ctx: WriteContext, customerUID: number) {
    const result = await this.customerBalance.recalcAndSync(ctx.orgUID, customerUID, ctx.userUID);
    if (result) await this.refreshCache(ctx.orgUID, customerUID);
    return result;
  }

  private async refreshCache(orgUID: number, customerUID: number) {
    const org = await this.orgSettings.get(orgUID);
    await this.cache.refresh(orgUID, org.OrgToken, customerUID);
  }

  private async requireCustomer(orgUID: number, customerUID: number) {
    if (!(await this.customers.findDebitCreditRaw(orgUID, customerUID))) throw new CiValidationError("Customer not found.");
  }
}
