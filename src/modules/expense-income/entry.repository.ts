import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

const ATTACHMENTS = "Transaction.ExpenseIncomeAttachmentsTbl";
const PAYMENTS = "Transaction.PaymentsTbl";

/**
 * Reads and writes the expense and indirect income pages share: dropdowns, payments and their attachments,
 * the bank / cash book and the record attachments (CI3 Expenses_model / Indirectincome_model / Transactions_model).
 */
@Injectable()
export class EntryRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getPaymentTypes
  async paymentTypes(): Promise<Row[]> {
    return this.read("Global.PaymentTypesTbl").select("PaymentTypeUID", "Name as PaymentTypeName", "IsCash").where({ IsActive: 1 }).orderBy("PaymentTypeUID", "asc");
  }

  // getBankAccounts — the organisation's bank accounts (cash accounts excluded)
  async bankAccounts(orgUID: number): Promise<Row[]> {
    return this.read("Organisation.OrgBankAccountsTbl")
      .select("BankAccountUID", "AccountName", "BankName", "IsDefault")
      .where({ OrgUID: orgUID, IsCash: 0, IsDeleted: 0, IsActive: 1 })
      .orderBy("IsDefault", "desc");
  }

  // getCashAccount — where a payment without a bank account is booked
  async cashAccountUID(orgUID: number, trx: Knex.Transaction): Promise<number | null> {
    const row = await trx("Organisation.OrgBankAccountsTbl").select("BankAccountUID").where({ OrgUID: orgUID, IsCash: 1, IsDeleted: 0, IsActive: 1 }).first();
    return row ? Number(row.BankAccountUID) : null;
  }

  // Login users for the "updated by" filter (CI3 getOrgUsersForCache)
  async orgUsers(orgUID: number): Promise<Row[]> {
    return this.read("Users.UserTbl")
      .select("UserUID", "FirstName", "LastName", this.read.raw("CONCAT(FirstName, ' ', LastName) AS FullName"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1, HasLoginAccess: 1 })
      .orderBy("FirstName", "asc");
  }

  // Userpreferences_model::getUserPreference
  async preference(orgUID: number, branchUID: number, userUID: number, key: string): Promise<string | null> {
    const row = await this.read("Users.UserPreferencesTbl").select("PreferenceValue").where({ OrgUID: orgUID, BranchUID: branchUID, UserUID: userUID, PreferenceKey: key }).first();
    return row?.PreferenceValue ?? null;
  }

  // GenSettings->CurrenySymbol (default ₹)
  async currencySymbol(orgUID: number): Promise<string> {
    const row = await this.read("Settings.OrgSettingsTbl").select("CurrenySymbol").where({ OrgUID: orgUID }).first();
    return row?.CurrenySymbol || "₹";
  }

  // GenSettings->ShowStats && TransSettings->ShowTransactionStats (both default on)
  async statsEnabled(orgUID: number): Promise<boolean> {
    const [general, transaction] = await Promise.all([
      this.read("Settings.OrgSettingsTbl").select("ShowStats").where({ OrgUID: orgUID }).first(),
      this.read("Settings.TransactionSettingsTbl").select("ShowTransactionStats").where({ OrgUID: orgUID }).first(),
    ]);
    return Number(general?.ShowStats ?? 1) === 1 && Number(transaction?.ShowTransactionStats ?? 1) === 1;
  }

  // getExpenseIncomeAttachments — with each file's CDN URL
  async attachments(orgUID: number, sourceType: string, sourceUID: number): Promise<Row[]> {
    const rows: Row[] = await this.read(ATTACHMENTS)
      .select("AttachUID", "FileName", "FilePath", "FileType", "FileSize", "SortOrder")
      .where({ SourceUID: sourceUID, SourceType: sourceType, OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy("SortOrder", "asc");
    return rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath as string) }));
  }

  // getMaxAttachmentSortOrder
  async maxAttachmentSort(orgUID: number, sourceType: string, sourceUID: number): Promise<number> {
    const row = await this.read(ATTACHMENTS).max("SortOrder as MaxOrder").where({ SourceUID: sourceUID, OrgUID: orgUID, SourceType: sourceType }).first();
    return Number(row?.MaxOrder ?? 0);
  }

  async insertAttachment(row: Row): Promise<void> {
    await this.db.write(ATTACHMENTS).insert(row);
  }

  // _softDeleteAttachments — only this organisation's attachments of this kind of record
  async softDeleteAttachments(orgUID: number, sourceType: string, attachUIDs: number[]): Promise<void> {
    if (attachUIDs.length === 0) return;
    await this.db.write(ATTACHMENTS).whereIn("AttachUID", attachUIDs).where({ OrgUID: orgUID, SourceType: sourceType }).update({ IsDeleted: 1, IsActive: 0 });
  }

  // getTransactionPayments — the record's live payments, oldest first
  async payments(orgUID: number, sourceType: string, transUID: number): Promise<Row[]> {
    return this.read(`${PAYMENTS} as P`)
      .select(
        "P.PaymentUID",
        "P.PaymentDate",
        "P.UniqueNumber",
        "P.Amount",
        "P.ReferenceNo",
        "P.Notes",
        "P.IsFullyPaid",
        "P.ExcessAmount",
        "P.CreatedOn",
        "P.SourceType",
        "PT.Name as PaymentTypeName",
        "PT.IsCash",
        "BA.AccountName",
        "BA.BankName",
        "BA.AccountNumber"
      )
      .leftJoin("Global.PaymentTypesTbl as PT", "PT.PaymentTypeUID", "P.PaymentTypeUID")
      .leftJoin("Organisation.OrgBankAccountsTbl as BA", "BA.BankAccountUID", "P.BankAccountUID")
      .where({ "P.TransUID": transUID, "P.SourceType": sourceType, "P.OrgUID": orgUID, "P.IsDeleted": 0, "P.IsActive": 1, "P.IsCancelled": 0 })
      .orderBy("P.PaymentUID", "asc");
  }

  // getPaymentAttachments — of several payments at once, with each file's CDN URL
  async paymentAttachments(orgUID: number, paymentUIDs: number[]): Promise<Row[]> {
    if (paymentUIDs.length === 0) return [];
    const rows: Row[] = await this.read("Transaction.PaymentAttachmentsTbl")
      .select("AttachUID", "PaymentUID", "FileName", "FilePath", "FileType", "FileSize", "CreatedOn")
      .whereIn("PaymentUID", paymentUIDs)
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .orderBy([{ column: "SortOrder" }, { column: "AttachUID" }]);
    return rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath as string) }));
  }

  async insertPaymentAttachment(row: Row): Promise<void> {
    await this.db.write("Transaction.PaymentAttachmentsTbl").insert(row);
  }

  // Payments already recorded for the record (the next one's UniqueNumber gets a -n suffix)
  async paymentCount(trx: Knex.Transaction, orgUID: number, sourceType: string, transUID: number): Promise<number> {
    const row = await trx(PAYMENTS).count("* as cnt").where({ TransUID: transUID, SourceType: sourceType, OrgUID: orgUID, IsDeleted: 0 }).first();
    return Number(row?.cnt ?? 0);
  }

  // getTransactionsPrefixDetails — the module's default prefix
  async paymentPrefixUID(trx: Knex.Transaction, orgUID: number, moduleUID: number): Promise<number | null> {
    const row = await trx("Settings.TransactionPrefixTbl")
      .select("PrefixUID")
      .where({ OrgUID: orgUID, ModuleUID: moduleUID, IsDeleted: 0, IsActive: 1 })
      .orderBy([{ column: "IsDefault", order: "desc" }, { column: "PrefixUID", order: "asc" }])
      .first();
    return row ? Number(row.PrefixUID) : null;
  }

  // getNextPaymentNumber — one above the year's highest, skipping numbers a live payment still holds
  async nextPaymentNumber(trx: Knex.Transaction, orgUID: number, prefixUID: number, transYear: number): Promise<number> {
    const scope = { PrefixUID: prefixUID, OrgUID: orgUID, TransYear: transYear };
    const row = await trx(PAYMENTS).max("PaymentNumber as MaxNumber").where(scope).first();
    let next = Number(row?.MaxNumber ?? 0) + 1;
    for (let attempt = 0; attempt < 100; attempt++) {
      const taken = await trx(PAYMENTS).select("PaymentUID").where({ ...scope, PaymentNumber: next, IsDeleted: 0 }).first();
      if (!taken) break;
      next++;
    }
    return next;
  }

  async insertPayment(trx: Knex.Transaction, row: Row): Promise<number> {
    const [id] = await trx(PAYMENTS).insert(row);
    return Number(id);
  }

  // A cancelled or deleted record's linked payment
  async voidPayment(trx: Knex.Transaction, orgUID: number, paymentUID: number, userUID: number): Promise<void> {
    await trx(PAYMENTS).where({ PaymentUID: paymentUID, OrgUID: orgUID }).update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID });
  }

  // One line in the bank / cash book (AccountLedgerTbl)
  async insertBankEntry(trx: Knex.Transaction, row: Row): Promise<void> {
    await trx("Transaction.AccountLedgerTbl").insert(row);
  }
}
