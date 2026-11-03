import { Injectable, Logger } from "@nestjs/common";
import { phpDate, phpRound } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postFlag, postInt, postValue } from "../../core/utils/form-values";
import { JournalService } from "../../libraries/journal/journal.service";
import { BankAccountsRepository } from "./bank-accounts.repository";

type Form = Record<string, unknown>;

// Trimmed posted text, '' when missing
const text = (form: Form, key: string): string => String(postValue(form, key) ?? "").trim();

// Settings → Bank Accounts (CI3 Settings bank functions).
@Injectable()
export class BankAccountsService {
  private readonly logger = new Logger(BankAccountsService.name);

  constructor(
    private readonly repo: BankAccountsRepository,
    private readonly db: DatabaseService,
    private readonly journal: JournalService,
    private readonly orgSettings: OrgSettingsService
  ) {}

  // getBankList — the CI3 JS builds the rows
  async getList(orgUID: number) {
    const rows = await this.repo.list(orgUID);
    return { Data: rows, TotalCount: rows.length };
  }

  // getBankBalance
  async getBalance(orgUID: number, bankUID: number) {
    if (bankUID <= 0) throw new CiValidationError("Invalid bank account ID.");
    return { Balance: phpRound(await this.repo.balance(orgUID, bankUID), 4) };
  }

  // getBankDetail
  async getDetail(orgUID: number, bankUID: number) {
    if (bankUID <= 0) throw new CiValidationError("Invalid bank account ID.");
    const bank = await this.repo.find(orgUID, bankUID);
    if (!bank) throw new CiValidationError("Bank account not found.");
    return { Data: bank };
  }

  // saveBankDetail — a new account also gets its ChartOfAccounts ledger, so fund transfers post straight away
  async save(form: Form, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    const bankUID = postInt(form, "BankAccountUID");
    const accountName = text(form, "AccountName");
    const accountNumber = text(form, "AccountNumber");
    const ifsc = text(form, "IFSC").toUpperCase();
    const bankName = text(form, "BankName");
    const branchName = text(form, "BranchName");
    if (!accountName) throw new CiValidationError("Account Holder Name is required.");
    if (!accountNumber) throw new CiValidationError("Account Number is required.");
    if (bankUID <= 0 && accountNumber !== text(form, "ConfirmAccountNumber")) throw new CiValidationError("Account numbers do not match.");
    if (!ifsc) throw new CiValidationError("IFSC Code is required.");
    if (!bankName) throw new CiValidationError("Bank Name is required.");
    if (!branchName) throw new CiValidationError("Branch Name is required.");

    const isDefault = postFlag(form, "IsDefault");
    const data = {
      AccountName: accountName,
      AccountNumber: accountNumber,
      IFSC: ifsc,
      BankName: bankName,
      BranchName: branchName,
      UPIId: text(form, "UPIId") || null,
      UPINumber: text(form, "UPINumber") || null,
      OpeningBalance: Number(postValue(form, "OpeningBalance") ?? 0) || 0,
      Notes: text(form, "Notes") || null,
      IsDefault: isDefault,
      UpdatedBy: userUID,
    };

    let message = "";
    await this.db.write.transaction(async (trx) => {
      if (isDefault) await this.repo.clearDefault(orgUID, userUID, trx);
      if (bankUID > 0) {
        await this.repo.update(orgUID, { BankAccountUID: bankUID, IsDeleted: 0, IsCash: 0 }, data, trx);
        message = "Bank account updated successfully.";
        return;
      }
      const newUID = await this.repo.insert({ ...data, OrgUID: orgUID, IsCash: 0, IsActive: 1, IsDeleted: 0, CreatedBy: userUID }, trx);
      // CI3 ignores a ledger failure here; the ledger is created later, on the first fund transfer
      await trx
        .transaction((ledgerTrx) => this.journal.bankLedgerUID(ledgerTrx, orgUID, newUID, userUID))
        .catch((err) => this.logger.warn(`Bank ledger ${newUID}: ${err.message}`));
      message = "Bank account added successfully.";
    });
    return { Message: message };
  }

  // deleteBankDetail — the cash account is kept
  async delete(bankUID: number, ctx: WriteContext) {
    if (bankUID <= 0) throw new CiValidationError("Invalid bank account ID.");
    const bank = await this.repo.find(ctx.orgUID, bankUID);
    if (!bank) throw new CiValidationError("Bank account not found.");
    if (Number(bank.IsCash) === 1) throw new CiValidationError("Cash account cannot be deleted.");
    await this.repo.update(ctx.orgUID, { BankAccountUID: bankUID }, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    return { Message: "Bank account deleted successfully." };
  }

  // setDefaultBank
  async setDefault(bankUID: number, ctx: WriteContext) {
    if (bankUID <= 0) throw new CiValidationError("Invalid bank account ID.");
    await this.db.write.transaction(async (trx) => {
      await this.repo.clearDefault(ctx.orgUID, ctx.userUID, trx);
      await this.repo.update(ctx.orgUID, { BankAccountUID: bankUID, IsDeleted: 0 }, { IsDefault: 1, UpdatedBy: ctx.userUID }, trx);
    });
    return { Message: "Default bank updated." };
  }

  // transferFunds — the transfer and its contra journal, then the out/in lines of the bank book
  async transfer(form: Form, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    const today = phpDate("Y-m-d", new Date(), (await this.orgSettings.get(orgUID)).Timezone);
    const fromUID = postInt(form, "FromBankUID");
    const toUID = postInt(form, "ToBankUID");
    const amount = Number(postValue(form, "Amount") ?? 0) || 0;
    const date = text(form, "TransferDate") || today;
    const referenceNo = text(form, "ReferenceNo") || null;
    if (fromUID <= 0) throw new CiValidationError("Please select source account.");
    if (toUID <= 0) throw new CiValidationError("Please select destination account.");
    if (fromUID === toUID) throw new CiValidationError("Source and destination cannot be the same.");
    if (amount <= 0) throw new CiValidationError("Transfer amount must be greater than zero.");

    const transferUID = await this.db.write.transaction(async (trx) => {
      const uid = await this.repo.insertTransfer(
        {
          OrgUID: orgUID,
          FromBankUID: fromUID,
          ToBankUID: toUID,
          Amount: amount,
          TransferDate: date,
          ReferenceNo: referenceNo,
          Notes: text(form, "Notes") || null,
          IsActive: 1,
          IsDeleted: 0,
          CreatedBy: userUID,
          UpdatedBy: userUID,
        },
        trx
      );
      // CI3 keeps the transfer when the journal fails (e.g. a locked period); a savepoint does the same here
      await trx
        .transaction((journalTrx) => this.journal.postFundTransfer(journalTrx, orgUID, uid, date, amount, fromUID, toUID, userUID))
        .catch((err) => this.logger.warn(`Fund transfer ${uid} journal skipped: ${err.message}`));
      return uid;
    });

    const label = `Fund transfer — Ref #${transferUID}${referenceNo ? ` / ${referenceNo}` : ""}`;
    const entry = { orgUID, amount, sourceType: "FundTransfer", sourceUID: transferUID, moduleUID: null, referenceNo, entryDate: date, userUID };
    await this.journal.writeBankLedgerEntry({ ...entry, bankAccountUID: fromUID, entryType: "DR", narration: `${label} (out)` });
    await this.journal.writeBankLedgerEntry({ ...entry, bankAccountUID: toUID, entryType: "CR", narration: `${label} (in)` });
    return { Message: "Funds transferred successfully." };
  }
}
