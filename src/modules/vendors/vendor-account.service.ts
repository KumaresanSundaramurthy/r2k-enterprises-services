import { Injectable } from "@nestjs/common";
import { BALANCE_FY_START_MONTH } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { currentFinancialYear } from "../../core/utils/financial-year";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { VendorBalanceService } from "../../libraries/vendor-balance/vendor-balance.service";
import { VendorIdDto, VendorOpeningBalanceSaveDto } from "./dto/vendor-write.dto";
import { VendorCacheService } from "./vendor-cache.service";
import { VendorsRepository } from "./vendors.repository";

/** Vendor balance writes (CI3 Vendors: saveVendorOpeningBalance, updateVendorBalance, recalcBalance). */
@Injectable()
export class VendorAccountService {
  constructor(
    private readonly db: DatabaseService,
    private readonly vendors: VendorsRepository,
    private readonly vendorBalance: VendorBalanceService,
    private readonly cache: VendorCacheService,
    private readonly audit: AuditLogService
  ) {}

  // saveVendorOpeningBalance — opening balance row and the year snapshot (the closing balance is not recalculated, as in CI3).
  async saveOpeningBalance(dto: VendorOpeningBalanceSaveDto, ctx: WriteContext) {
    const vendorUID = postInt(dto, "VendorUID");
    const balance = Number(postValue(dto, "OpeningBalance", 0)) || 0;
    const balanceType = (postString(dto, "BalanceType") ?? "").trim();
    const notes = (postString(dto, "Notes") ?? "").trim();
    const requestedYear = postInt(dto, "FinancialYear");
    if (vendorUID <= 0) throw new CiValidationError("Invalid vendor.");
    if (balance < 0) throw new CiValidationError("Opening balance cannot be negative.");
    if (balanceType !== "Debit" && balanceType !== "Credit") throw new CiValidationError("BalanceType must be Debit or Credit.");
    if (!(await this.vendors.findDebitCreditRaw(ctx.orgUID, vendorUID))) throw new CiValidationError("Vendor not found.");
    const financialYear = requestedYear > 0 ? requestedYear : currentFinancialYear(BALANCE_FY_START_MONTH);

    const before = await this.vendors.findOpeningBalance(ctx.orgUID, vendorUID);
    const vendBalUID = await this.db.transaction(async (trx) => {
      const id = await this.vendors.saveOpeningBalance(trx, ctx.orgUID, vendorUID, balance, balanceType, notes, ctx.userUID);
      await this.vendors.saveYearOpening(trx, ctx.orgUID, vendorUID, financialYear, balance, balanceType, ctx.userUID);
      return id;
    });

    await this.cache.refresh(ctx.orgUID, vendorUID);
    const values = { balance, balanceType, financialYear };
    await this.audit.log(ctx, {
      action: "SET_VENDOR_OPENING_BALANCE",
      entityType: "Vendor",
      entityUID: vendorUID,
      details: values,
      summary: `Set opening balance ${balanceType} ${balance} for vendor #${vendorUID}`,
      module: "Vendors",
      category: "MASTER",
      oldValues: before ? { balance: before.OpeningBalance, balanceType: before.OpeningBalType } : {},
      newValues: values,
    });
    return { Message: "Opening balance saved successfully.", VendBalUID: vendBalUID, FinancialYear: financialYear };
  }

  // updateVendorBalance — stores opening + purchased − paid − returned for one vendor, or all when VendorUID is 0.
  async updateStoredBalances(dto: VendorIdDto, ctx: WriteContext) {
    const vendorUID = postInt(dto, "VendorUID");
    const result = await this.vendorBalance.storeLiveBalances(ctx.orgUID, vendorUID, ctx.userUID);
    if (result.found === 0) throw new CiValidationError("No vendors found to update.");

    await this.audit.log(ctx, {
      action: "RECALC_VENDOR_BALANCE",
      entityType: "Vendor",
      entityUID: vendorUID,
      details: { updated: result.updated, skipped: result.skipped, filterUID: vendorUID },
      summary: `Recalculated vendor balances: ${result.updated} updated, ${result.skipped} skipped`,
      module: "Vendors",
      category: "MASTER",
    });
    return {
      Message: `Balance recalculated: ${result.updated} updated, ${result.skipped} skipped.`,
      Updated: result.updated,
      Skipped: result.skipped,
      ...(result.errors.length > 0 ? { Errors: result.errors } : {}),
    };
  }

  // recalcBalance — full recalculation (with debit / credit notes) for one vendor, or every vendor of the organisation.
  async recalculate(dto: VendorIdDto, ctx: WriteContext) {
    const vendorUID = postInt(dto, "VendorUID");
    if (vendorUID > 0) {
      const result = await this.recalcAndCache(ctx, vendorUID);
      if (!result) throw new CiValidationError("Vendor not found or recalculation failed.");
      return { Message: "Balance recalculated successfully.", Balance: result.balance, BalanceType: result.type };
    }

    const vendorUIDs = await this.vendors.findAllUIDs(ctx.orgUID);
    if (vendorUIDs.length === 0) throw new CiValidationError("No vendors found for this organisation.");
    let success = 0;
    for (const uid of vendorUIDs) {
      if (await this.recalcAndCache(ctx, uid)) success++;
    }
    const failed = vendorUIDs.length - success;
    return {
      Message: `Recalculated ${success} of ${vendorUIDs.length} vendors.` + (failed > 0 ? ` ${failed} failed — check logs.` : ""),
      Total: vendorUIDs.length,
      Success: success,
      Failed: failed,
    };
  }

  // recalcAndSync + cache refresh (CI3 Vendorbalance::recalcAndSync refreshes the cache itself)
  private async recalcAndCache(ctx: WriteContext, vendorUID: number) {
    const result = await this.vendorBalance.recalcAndSync(ctx.orgUID, vendorUID, ctx.userUID);
    if (result) await this.cache.refresh(ctx.orgUID, vendorUID);
    return result;
  }
}
