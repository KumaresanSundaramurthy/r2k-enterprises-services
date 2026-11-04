import { Injectable } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { CacheHelperService } from "../../libraries/cache-helper/cache-helper.service";

type Form = Record<string, unknown>;

const BANKS = "Organisation.OrgBankAccountsTbl";
const trimmed = (form: Form, key: string) => String(postValue(form, key) ?? "").trim();

/**
 * Bank accounts from the payments page (CI3 Payments::saveBankAccount / setDefaultBank / deleteBankAccount).
 * Each change drops CI3's cached org-bank-accounts list so its forms read the new one.
 */
@Injectable()
export class PaymentBanksService {
  constructor(
    private readonly db: DatabaseService,
    private readonly cacheHelper: CacheHelperService,
    private readonly redis: RedisService,
    private readonly orgSettings: OrgSettingsService,
    private readonly audit: AuditLogService
  ) {}

  // saveBankAccount — create or update; a default account clears the other defaults
  async save(ctx: WriteContext, form: Form) {
    const { orgUID, userUID } = ctx;
    const accountUID = postInt(form, "BankAccountUID");
    const isDefault = postInt(form, "IsDefault") === 1 ? 1 : 0;
    const data = {
      OrgUID: orgUID,
      AccountName: trimmed(form, "AccountName"),
      BankName: trimmed(form, "BankName"),
      AccountNumber: trimmed(form, "AccountNumber"),
      IFSC: trimmed(form, "IFSC").toUpperCase() || null,
      BranchName: trimmed(form, "BranchName") || null,
      UPIId: trimmed(form, "UPIId") || null,
      UPINumber: trimmed(form, "UPINumber") || null,
      IsDefault: isDefault,
      IsActive: 1,
      IsDeleted: 0,
      UpdatedBy: userUID,
    };
    if (!data.AccountName) throw new CiValidationError("Account holder name is required.");
    if (!data.BankName) throw new CiValidationError("Bank name is required.");
    if (!data.AccountNumber) throw new CiValidationError("Account number is required.");
    if (accountUID <= 0 && data.AccountNumber !== trimmed(form, "ConfirmAccountNumber")) throw new CiValidationError("Account number and confirmation do not match.");

    const savedUID = await this.db.write.transaction(async (trx) => {
      if (isDefault) await trx(BANKS).where({ OrgUID: orgUID, IsDeleted: 0 }).update({ IsDefault: 0, UpdatedBy: userUID });
      if (accountUID > 0) {
        await trx(BANKS).where({ BankAccountUID: accountUID, OrgUID: orgUID, IsDeleted: 0 }).update(data);
        return accountUID;
      }
      const [id] = await trx(BANKS).insert({ ...data, CreatedBy: userUID });
      return Number(id);
    });
    await this.dropCache(orgUID);
    await this.audit.log(ctx, {
      action: "SAVE_BANK_ACCOUNT",
      entityType: "BankAccount",
      entityUID: savedUID,
      entityRef: data.AccountName,
      details: { IsUpdate: accountUID > 0 },
      summary: `${accountUID > 0 ? "Updated" : "Added"} bank account ${data.AccountName}`,
      module: "Payments",
      category: "SETTINGS",
    });
    return { Message: accountUID > 0 ? "Bank account updated." : "Bank account added.", ...(accountUID > 0 ? {} : { BankAccountUID: savedUID }) };
  }

  // setDefaultBank
  async setDefault(ctx: WriteContext, form: Form) {
    const bankAccountUID = postInt(form, "BankAccountUID");
    if (bankAccountUID <= 0) throw new CiValidationError("Bank account ID is required.");
    await this.db.write.transaction(async (trx) => {
      await trx(BANKS).where({ OrgUID: ctx.orgUID, IsDeleted: 0 }).update({ IsDefault: 0, UpdatedBy: ctx.userUID });
      await trx(BANKS).where({ BankAccountUID: bankAccountUID, OrgUID: ctx.orgUID, IsDeleted: 0 }).update({ IsDefault: 1, UpdatedBy: ctx.userUID });
    });
    await this.dropCache(ctx.orgUID);
    return { Message: "Default bank updated." };
  }

  // deleteBankAccount — soft delete
  async delete(ctx: WriteContext, form: Form) {
    const bankAccountUID = postInt(form, "BankAccountUID");
    if (bankAccountUID <= 0) throw new CiValidationError("Bank account ID is required.");
    await this.db.write(BANKS).where({ BankAccountUID: bankAccountUID, OrgUID: ctx.orgUID, IsDeleted: 0 }).update({ IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    await this.dropCache(ctx.orgUID);
    await this.audit.log(ctx, {
      action: "DELETE_BANK_ACCOUNT",
      entityType: "BankAccount",
      entityUID: bankAccountUID,
      entityRef: "",
      summary: `Deleted bank account #${bankAccountUID}`,
      module: "Payments",
      category: "SETTINGS",
    });
    return { Message: "Bank account deleted." };
  }

  private async dropCache(orgUID: number): Promise<void> {
    await this.cacheHelper.deleteKeys(this.redis.orgKey("org-bank-accounts", (await this.orgSettings.get(orgUID)).OrgToken));
  }
}
