import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { resolveCdnUrl, toInt } from "../../common/utils/php-compat";
import { VendorListFilterDto } from "./dto/vendor-list.dto";

export type Row = Record<string, string | null>;

export interface VendorListResult {
  rows: Row[];
  totalCount: number;
}

// Columns searched by the list page and the search list (CI3 SearchAllData)
const LIST_SEARCH_COLUMNS = ["Vendors.Name", "Vendors.Area", "Vendors.MobileNumber", "Vendors.ContactPerson"];

// Queries only (CI3 Vendors_model). Every table is schema-qualified; no default database.
@Injectable()
export class VendorsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getVendorListPaginated — count + page of rows with translations, ledger balance and attachment previews.
  async listPaginated(orgUID: number, pageNo: number, limit: number, filter: VendorListFilterDto, langCode: string): Promise<VendorListResult> {
    const countRow = await this.applyListFilters(this.read("Vendors.VendorTbl as Vendors").count({ cnt: "*" }), orgUID, filter).first();
    const totalCount = toInt(countRow?.cnt);

    const useLang = BaseRepository.useLang(langCode);
    // Ledger balance through correlated subqueries, so a vendor with several ledger rows stays one row (as in CI3)
    const ledgerValue = (column: string, fallback: string, alias: string) =>
      this.read.raw(
        `IFNULL((SELECT COA2.?? FROM Accounting.EntityLedgerMap ELM2 JOIN Accounting.ChartOfAccounts COA2 ON COA2.LedgerUID = ELM2.LedgerUID AND COA2.IsDeleted = 0 WHERE ELM2.VendorUID = Vendors.VendorUID AND ELM2.EntityType = 'Vendor' AND ELM2.IsDeleted = 0 LIMIT 1), ${fallback}) AS ??`,
        [column, alias]
      );
    const query = this.read("Vendors.VendorTbl as Vendors")
      .select(
        "Vendors.VendorUID as TablePrimaryUID",
        "Vendors.VendorUID as VendorUID",
        "Vendors.OrgUID as OrgUID",
        "Vendors.SalutationUID as SalutationUID",
        "Sal.SalutationName as SalutationName",
        this.langColumn(useLang, "VL.Name", "Vendors.Name", "Name"),
        this.langColumn(useLang, "VL.Area", "Vendors.Area", "Area"),
        "Vendors.CountryISO2 as CountryISO2",
        "Vendors.CountryCode as CountryCode",
        "Vendors.MobileNumber as MobileNumber",
        "Vendors.EmailAddress as EmailAddress",
        "Vendors.GSTIN as GSTIN",
        "Vendors.GSTINValidated as GSTINValidated",
        "Vendors.VendorNumber as VendorNumber",
        this.langColumn(useLang, "VL.CompanyName", "Vendors.CompanyName", "CompanyName"),
        "Vendors.WorkPhone as WorkPhone",
        "Vendors.LandlineNumber as LandlineNumber",
        "Vendors.DebitCreditType as DebitCreditType",
        "Vendors.DebitCreditAmount as DebitCreditAmount",
        "Vendors.Image as Image",
        "Vendors.PANNumber as PANNumber",
        this.langColumn(useLang, "VL.ContactPerson", "Vendors.ContactPerson", "ContactPerson"),
        this.langColumn(useLang, "VL.Notes", "Vendors.Notes", "Notes"),
        "Vendors.Tags as Tags",
        "Vendors.CCEmails as CCEmails",
        "Vendors.IsActive as IsActive",
        "Vendors.CreatedOn as CreatedOn",
        "Vendors.UpdatedOn as UpdatedOn",
        this.read.raw("CONCAT(??, ' ', ??) AS ??", ["User.FirstName", "User.LastName", "UpdatedBy"]),
        ledgerValue("CurrentBalance", "0.00", "ClosingBalance"),
        ledgerValue("CurrentBalanceType", "'Credit'", "ClosingBalanceType")
      )
      .leftJoin("Users.UserTbl as User", "User.UserUID", "Vendors.UpdatedBy")
      .leftJoin("Global.SalutationTbl as Sal", (on) => {
        on.on("Sal.SalutationUID", "Vendors.SalutationUID").andOnVal("Sal.IsDeleted", "=", 0);
      });
    if (useLang) {
      query.leftJoin("Vendors.VendorTbl_Lang as VL", (on) => {
        on.on("VL.VendorUID", "Vendors.VendorUID").andOnVal("VL.LangCode", "=", langCode);
      });
    }
    this.applyListFilters(query, orgUID, filter);

    if (filter.NameSorting) query.orderBy("Vendors.Name", filter.NameSorting === 1 ? "asc" : "desc");
    else if (filter.AreaSorting) query.orderBy("Vendors.Area", filter.AreaSorting === 1 ? "asc" : "desc");
    else if (filter.BalanceSorting) query.orderBy("ClosingBalance", filter.BalanceSorting === 1 ? "asc" : "desc");
    else query.orderBy("Vendors.VendorUID", "desc");
    if (limit > 0) query.limit(limit).offset(BaseRepository.offset(pageNo, limit));

    const rows: Row[] = await query;
    await this.attachPreviews(rows);
    return { rows, totalCount };
  }

  // getVendors — one active vendor of the organisation with the linked customer's name.
  async findDetail(orgUID: number, vendorUID: number, langCode: string): Promise<Row | null> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Vendors.VendorTbl as Vendors")
      .select(
        "Vendors.VendorUID as VendorUID",
        "Vendors.SalutationUID as SalutationUID",
        "Vendors.OrgUID as OrgUID",
        this.langColumn(useLang, "VL.Name", "Vendors.Name", "Name"),
        this.langColumn(useLang, "VL.Area", "Vendors.Area", "Area"),
        "Vendors.CountryISO2 as CountryISO2",
        "Vendors.CountryCode as CountryCode",
        "Vendors.MobileNumber as MobileNumber",
        "Vendors.EmailAddress as EmailAddress",
        "Vendors.CustomerUID as CustomerUID",
        "Vendors.GSTIN as GSTIN",
        "Vendors.GSTINValidated as GSTINValidated",
        "Vendors.VendorNumber as VendorNumber",
        this.langColumn(useLang, "VL.CompanyName", "Vendors.CompanyName", "CompanyName"),
        "Vendors.WorkPhone as WorkPhone",
        "Vendors.LandlineNumber as LandlineNumber",
        "Vendors.DebitCreditType as DebitCreditType",
        "Vendors.DebitCreditAmount as DebitCreditAmount",
        "Vendors.Image as Image",
        "Vendors.PANNumber as PANNumber",
        this.langColumn(useLang, "VL.ContactPerson", "Vendors.ContactPerson", "ContactPerson"),
        "Vendors.DateOfBirth as DateOfBirth",
        this.langColumn(useLang, "VL.Notes", "Vendors.Notes", "Notes"),
        "Customers.Name as CustomerName",
        "Vendors.CreatedOn as CreatedOn",
        "Vendors.UpdatedOn as UpdatedOn"
      )
      .leftJoin("Customers.CustomerTbl as Customers", "Customers.CustomerUID", "Vendors.CustomerUID")
      .where({ "Vendors.VendorUID": vendorUID, "Vendors.OrgUID": orgUID, "Vendors.IsDeleted": 0, "Vendors.IsActive": 1 });
    if (useLang) {
      query.leftJoin("Vendors.VendorTbl_Lang as VL", (on) => {
        on.on("VL.VendorUID", "Vendors.VendorUID").andOnVal("VL.LangCode", "=", langCode);
      });
    }
    const row = await query.first();
    return row ?? null;
  }

  // getVendorAddress — billing and shipping rows.
  async findAddresses(vendorUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Vendors.VendAddressTbl as VendAddress")
      .select(
        "VendAddress.VendAddressUID as VendAddressUID",
        "VendAddress.OrgUID as OrgUID",
        "VendAddress.VendorUID as VendorUID",
        "VendAddress.AddressType as AddressType",
        this.langColumn(useLang, "VAL.Line1", "VendAddress.Line1", "Line1"),
        this.langColumn(useLang, "VAL.Line2", "VendAddress.Line2", "Line2"),
        "VendAddress.Pincode as Pincode",
        "VendAddress.City as City",
        this.langColumn(useLang, "VAL.CityText", "VendAddress.CityText", "CityText"),
        "VendAddress.State as State",
        this.langColumn(useLang, "VAL.StateText", "VendAddress.StateText", "StateText")
      )
      .where({ "VendAddress.VendorUID": vendorUID, "VendAddress.IsDeleted": 0, "VendAddress.IsActive": 1 });
    if (useLang) {
      query.leftJoin("Vendors.VendAddressTbl_Lang as VAL", (on) => {
        on.on("VAL.VendAddressUID", "VendAddress.VendAddressUID").andOnVal("VAL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // Billing addresses of several vendors in one query (the search list's address per row)
  async findBillingAddresses(vendorUIDs: number[], langCode: string): Promise<Row[]> {
    if (vendorUIDs.length === 0) return [];
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Vendors.VendAddressTbl as VendAddress")
      .select(
        "VendAddress.VendorUID as VendorUID",
        this.langColumn(useLang, "VAL.Line1", "VendAddress.Line1", "Line1"),
        this.langColumn(useLang, "VAL.Line2", "VendAddress.Line2", "Line2"),
        this.langColumn(useLang, "VAL.CityText", "VendAddress.CityText", "CityText"),
        this.langColumn(useLang, "VAL.StateText", "VendAddress.StateText", "StateText"),
        "VendAddress.Pincode as Pincode"
      )
      .whereIn("VendAddress.VendorUID", vendorUIDs)
      .where({ "VendAddress.AddressType": "Billing", "VendAddress.IsDeleted": 0, "VendAddress.IsActive": 1 })
      .orderBy("VendAddress.VendAddressUID", "asc");
    if (useLang) {
      query.leftJoin("Vendors.VendAddressTbl_Lang as VAL", (on) => {
        on.on("VAL.VendAddressUID", "VendAddress.VendAddressUID").andOnVal("VAL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getVendorBankInfo
  async findBankDetails(vendorUID: number): Promise<Row[]> {
    return this.read("Vendors.VendBankDetailsTbl as VendBankDetails")
      .select(
        "VendBankDetails.VendBankDetUID as VendBankDetUID",
        "VendBankDetails.VendorUID as VendorUID",
        "VendBankDetails.Type as Type",
        "VendBankDetails.BankAccountNumber as BankAccountNumber",
        "VendBankDetails.BankIFSC_Code as BankIFSC_Code",
        "VendBankDetails.BankBranchName as BankBranchName",
        "VendBankDetails.BankAccountHolderName as BankAccountHolderName",
        "VendBankDetails.UPI_Id as UPI_Id"
      )
      .where({ "VendBankDetails.VendorUID": vendorUID, "VendBankDetails.IsDeleted": 0, "VendBankDetails.IsActive": 1 });
  }

  // getVendorAttachments — each row also gets its CDN Url.
  async findAttachments(orgUID: number, vendorUID: number): Promise<Row[]> {
    const rows: Row[] = await this.read("Vendors.VendorAttachmentsTbl")
      .select("AttachUID", "FileName", "FilePath", "FileSize", "SortOrder", "CreatedOn")
      .where({ VendorUID: vendorUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("SortOrder", "asc");
    return rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath) }));
  }

  // getVendorTags — distinct tags across active vendors, in first-seen order.
  async findTags(orgUID: number): Promise<string[]> {
    const rows: { Tags: string }[] = await this.read("Vendors.VendorTbl as Vendors")
      .select("Vendors.Tags as Tags")
      .where({ "Vendors.OrgUID": orgUID, "Vendors.IsDeleted": 0, "Vendors.IsActive": 1 })
      .whereNotNull("Vendors.Tags")
      .whereNot("Vendors.Tags", "");
    const tags = new Set<string>();
    for (const row of rows) {
      for (const tag of row.Tags.split(",")) {
        const trimmed = tag.trim();
        if (trimmed) tags.add(trimmed);
      }
    }
    return [...tags];
  }

  // getVendorStats — totals for the list page header (dates are YYYY-MM-DD, UTC like CI3's date()).
  async stats(orgUID: number, period: { monthStart: string; nextMonthStart: string; lastMonthStart: string; fyStart: string }): Promise<Row | null> {
    const raw = (sql: string, bindings: (string | number)[]) => this.read.raw(sql, bindings);
    const row = await this.read("Vendors.VendorTbl as V")
      .select(
        raw("COUNT(??) AS ??", ["V.VendorUID", "TotalCount"]),
        raw("SUM(CASE WHEN ?? = 1 THEN 1 ELSE 0 END) AS ??", ["V.IsActive", "ActiveCount"]),
        raw("SUM(CASE WHEN ?? >= ? AND ?? < ? THEN 1 ELSE 0 END) AS ??", ["V.CreatedOn", period.monthStart, "V.CreatedOn", period.nextMonthStart, "MonthCount"]),
        raw("SUM(CASE WHEN ?? >= ? THEN 1 ELSE 0 END) AS ??", ["V.CreatedOn", period.fyStart, "FYCount"]),
        raw("SUM(CASE WHEN ?? >= ? AND ?? < ? THEN 1 ELSE 0 END) AS ??", ["V.CreatedOn", period.lastMonthStart, "V.CreatedOn", period.monthStart, "LastMonthCount"]),
        // To collect: vendors who owe us (Debit balance — advance paid to the vendor)
        raw("SUM(CASE WHEN ?? = 'Debit' AND ?? > 0 THEN 1 ELSE 0 END) AS ??", ["VOB.PendingBalType", "VOB.PendingBalance", "ToCollectCount"]),
        raw("COALESCE(SUM(CASE WHEN ?? = 'Debit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", [
          "VOB.PendingBalType",
          "VOB.PendingBalance",
          "VOB.PendingBalance",
          "ToCollectAmount",
        ]),
        // To pay: we owe the vendor (Credit balance — standard payables)
        raw("SUM(CASE WHEN ?? = 'Credit' AND ?? > 0 THEN 1 ELSE 0 END) AS ??", ["VOB.PendingBalType", "VOB.PendingBalance", "ToPayCount"]),
        raw("COALESCE(SUM(CASE WHEN ?? = 'Credit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", [
          "VOB.PendingBalType",
          "VOB.PendingBalance",
          "VOB.PendingBalance",
          "ToPayAmount",
        ])
      )
      .leftJoin("Vendors.VendOpeningBalanceTbl as VOB", (on) => {
        on.on("VOB.VendorUID", "V.VendorUID").andOn("VOB.OrgUID", "V.OrgUID").andOnVal("VOB.IsDeleted", "=", 0);
      })
      .where({ "V.IsDeleted": 0, "V.OrgUID": orgUID })
      .first();
    return row ?? null;
  }

  // getVendorOpeningBalance — opening + current closing balance row.
  async findOpeningBalance(orgUID: number, vendorUID: number, trx?: Knex.Transaction): Promise<Row | null> {
    const row = await (trx ?? this.read)("Vendors.VendOpeningBalanceTbl")
      .select("VendBalUID", "OpeningBalance", "OpeningBalType", "PendingBalance", "PendingBalType", "Notes")
      .where({ OrgUID: orgUID, VendorUID: vendorUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getVendorYearOpening — opening balance snapshot for one financial year.
  async findYearOpening(orgUID: number, vendorUID: number, financialYear: number, trx?: Knex.Transaction): Promise<Row | null> {
    const row = await (trx ?? this.read)("Vendors.VendYearOpeningBalanceTbl")
      .select("YearBalUID", "FinancialYear", "OpeningBalance", "OpeningBalType")
      .where({ OrgUID: orgUID, VendorUID: vendorUID, FinancialYear: financialYear, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getVendorClosingBalanceFresh — the vendor ledger's current balance (0 / Credit when there is no ledger)
  async findLedgerBalance(vendorUID: number): Promise<{ balance: number; type: string }> {
    const row = await this.read("Accounting.EntityLedgerMap as ELM")
      .select("COA.CurrentBalance as CurrentBalance", "COA.CurrentBalanceType as CurrentBalanceType")
      .join("Accounting.ChartOfAccounts as COA", (on) => {
        on.on("COA.LedgerUID", "ELM.LedgerUID").andOnVal("COA.IsDeleted", "=", 0);
      })
      .where({ "ELM.VendorUID": vendorUID, "ELM.EntityType": "Vendor", "ELM.IsDeleted": 0 })
      .first();
    return { balance: Number(row?.CurrentBalance ?? 0), type: row?.CurrentBalanceType ?? "Credit" };
  }

  // getEntityWithLedger — the vendor (deleted or not) with its linked ledger.
  async findWithLedger(orgUID: number, vendorUID: number): Promise<Row | null> {
    const row = await this.read("Vendors.VendorTbl as v")
      .select(
        "v.VendorUID as VendorUID",
        "v.Name as EntityName",
        "v.IsDeleted as IsDeleted",
        "v.IsActive as IsActive",
        "el.LedgerUID as LedgerUID",
        "ca.LedgerCode as LedgerCode",
        "ca.LedgerName as LedgerName",
        "ca.OpeningBalance as OpeningBalance",
        "ca.OpeningBalanceType as OpeningBalanceType",
        "ca.ParentLedgerUID as ParentLedgerUID"
      )
      .leftJoin("Accounting.EntityLedgerMap as el", (on) => {
        on.on("el.VendorUID", "v.VendorUID").andOnVal("el.EntityType", "=", "Vendor");
      })
      .leftJoin("Accounting.ChartOfAccounts as ca", (on) => {
        on.on("ca.LedgerUID", "el.LedgerUID").andOnVal("ca.IsDeleted", "=", 0);
      })
      .where({ "v.VendorUID": vendorUID, "v.OrgUID": orgUID })
      .first();
    return row ?? null;
  }

  // getVendorDebitCreditRaw — opening values on the vendor row before an update.
  async findDebitCreditRaw(orgUID: number, vendorUID: number): Promise<Row | null> {
    const row = await this.read("Vendors.VendorTbl")
      .select("DebitCreditAmount", "DebitCreditType")
      .where({ VendorUID: vendorUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // vendorHasTransactions (Transactions_model::getEntityInvoices) — any active supplier transaction.
  async hasTransactions(orgUID: number, vendorUID: number): Promise<boolean> {
    const row = await this.read("Transaction.TransactionsTbl")
      .select("TransUID")
      .where({ OrgUID: orgUID, PartyUID: vendorUID, PartyType: "S", IsDeleted: 0, IsActive: 1 })
      .first();
    return !!row;
  }

  // getVendorUIDsByFilter — every vendor the list filter matches (bulk "select all").
  async findUIDsByFilter(orgUID: number, filter: VendorListFilterDto): Promise<number[]> {
    const rows: { VendorUID: string }[] = await this.applyListFilters(
      this.read("Vendors.VendorTbl as Vendors").select("Vendors.VendorUID as VendorUID"),
      orgUID,
      filter
    );
    return rows.map((row) => toInt(row.VendorUID));
  }

  // getAllVendorUIDs — every non-deleted vendor of the organisation
  async findAllUIDs(orgUID: number): Promise<number[]> {
    const rows: { VendorUID: string }[] = await this.read("Vendors.VendorTbl")
      .select("VendorUID")
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("VendorUID", "asc");
    return rows.map((row) => toInt(row.VendorUID));
  }

  // Active vendors of the organisation (CI3 getVendors filter: IsDeleted = 0, IsActive = 1)
  async findActiveUIDs(orgUID: number): Promise<number[]> {
    const rows: { VendorUID: string }[] = await this.read("Vendors.VendorTbl")
      .select("VendorUID")
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy("VendorUID", "asc");
    return rows.map((row) => toInt(row.VendorUID));
  }

  // Billing address of a vendor (CI3 getVendorAddress with AddressType = Billing)
  async findBillingAddressUID(orgUID: number, vendorUID: number): Promise<number | null> {
    const row = await this.read("Vendors.VendAddressTbl")
      .select("VendAddressUID")
      .where({ VendorUID: vendorUID, OrgUID: orgUID, AddressType: "Billing", IsDeleted: 0, IsActive: 1 })
      .first();
    return row ? toInt(row.VendAddressUID) : null;
  }

  // getAttachmentSortStats — highest SortOrder, count and total size of the vendor's attachments
  async attachmentStats(orgUID: number, vendorUID: number) {
    const row = await this.read("Vendors.VendorAttachmentsTbl")
      .select(
        this.read.raw("COALESCE(MAX(??), 0) AS ??", ["SortOrder", "maxSort"]),
        this.read.raw("COUNT(*) AS ??", ["count"]),
        this.read.raw("COALESCE(SUM(??), 0) AS ??", ["FileSize", "totalSize"])
      )
      .where({ VendorUID: vendorUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return { maxSort: toInt(row?.maxSort), count: toInt(row?.count), totalSize: Number(row?.totalSize ?? 0) };
  }

  // getVendorPrimaryImage — FilePath of the first attachment, or null
  async findPrimaryImage(orgUID: number, vendorUID: number): Promise<string | null> {
    const row = await this.read("Vendors.VendorAttachmentsTbl")
      .select("FilePath")
      .where({ VendorUID: vendorUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("SortOrder", "asc")
      .first();
    return row?.FilePath ?? null;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  async insertVendor(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number> {
    const [vendorUID] = await trx("Vendors.VendorTbl").insert(row);
    return vendorUID;
  }

  async updateVendor(orgUID: number, vendorUID: number, data: Record<string, unknown>, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)("Vendors.VendorTbl").where({ VendorUID: vendorUID, OrgUID: orgUID }).update(data);
  }

  // Customer created from the vendor form (CustomerLinkingCheck = NewCustomer)
  async insertLinkedCustomer(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number> {
    const [customerUID] = await trx("Customers.CustomerTbl").insert(row);
    return customerUID;
  }

  // Soft delete (CI3 baseDeleteArrayDetails: IsDeleted = 1, UpdatedBy)
  async softDelete(trx: Knex.Transaction, orgUID: number, vendorUIDs: number[], userUID: number): Promise<void> {
    await trx("Vendors.VendorTbl").where({ OrgUID: orgUID }).whereIn("VendorUID", vendorUIDs).update({ IsDeleted: 1, UpdatedBy: userUID });
  }

  // updateBillingAddress — updates the billing row, or inserts it when the vendor has none.
  async saveBillingAddress(existingUID: number | null, row: Record<string, unknown>, userUID: number): Promise<void> {
    if (existingUID) {
      await this.writer()("Vendors.VendAddressTbl").where({ VendAddressUID: existingUID }).update(row);
    } else {
      await this.writer()("Vendors.VendAddressTbl").insert({ ...row, CreatedBy: userUID });
    }
  }

  async insertAttachment(row: Record<string, unknown>): Promise<void> {
    await this.writer()("Vendors.VendorAttachmentsTbl").insert(row);
  }

  // Soft-deletes attachments of the organisation; vendorUID 0 = any vendor (CI3 deleteVendorAttachment)
  async softDeleteAttachments(orgUID: number, vendorUID: number, attachUIDs: number[], userUID: number): Promise<number> {
    if (attachUIDs.length === 0) return 0;
    const query = this.writer()("Vendors.VendorAttachmentsTbl").whereIn("AttachUID", attachUIDs).where({ OrgUID: orgUID, IsDeleted: 0 });
    if (vendorUID > 0) query.where({ VendorUID: vendorUID });
    return query.update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID });
  }

  /**
   * saveVendorOpeningBalance — updates the existing row, or inserts one (closing balance starts equal to
   * opening). `notes` undefined leaves Notes untouched on update.
   */
  async saveOpeningBalance(
    trx: Knex.Transaction,
    orgUID: number,
    vendorUID: number,
    amount: number,
    type: string,
    notes: string | null | undefined,
    userUID: number
  ): Promise<number> {
    const existing = await this.findOpeningBalance(orgUID, vendorUID, trx);
    if (existing) {
      await trx("Vendors.VendOpeningBalanceTbl")
        .where({ VendBalUID: existing.VendBalUID })
        .update({ OpeningBalance: amount, OpeningBalType: type, ...(notes !== undefined ? { Notes: notes || null } : {}), UpdatedBy: userUID });
      return toInt(existing.VendBalUID);
    }
    const [vendBalUID] = await trx("Vendors.VendOpeningBalanceTbl").insert({
      OrgUID: orgUID,
      VendorUID: vendorUID,
      OpeningBalance: amount,
      OpeningBalType: type,
      PendingBalance: amount,
      PendingBalType: type,
      Notes: notes || null,
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: userUID,
      UpdatedBy: userUID,
    });
    return vendBalUID;
  }

  // saveVendorYearOpening — onlyIfNew keeps an existing year-start snapshot untouched.
  async saveYearOpening(
    trx: Knex.Transaction,
    orgUID: number,
    vendorUID: number,
    financialYear: number,
    amount: number,
    type: string,
    userUID: number,
    onlyIfNew = false
  ): Promise<void> {
    const existing = await this.findYearOpening(orgUID, vendorUID, financialYear, trx);
    if (existing) {
      if (onlyIfNew) return;
      await trx("Vendors.VendYearOpeningBalanceTbl")
        .where({ YearBalUID: existing.YearBalUID })
        .update({ OpeningBalance: amount, OpeningBalType: type, UpdatedBy: userUID });
      return;
    }
    await trx("Vendors.VendYearOpeningBalanceTbl").insert({
      OrgUID: orgUID,
      VendorUID: vendorUID,
      FinancialYear: financialYear,
      OpeningBalance: amount,
      OpeningBalType: type,
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: userUID,
      UpdatedBy: userUID,
    });
  }

  // saveVendLangRow — translated vendor text (one row per vendor and language).
  async saveLangRow(
    vendorUID: number,
    langCode: string,
    text: { Name: string; ContactPerson: string | null; Notes: string | null; Area: string | null; CompanyName: string | null },
    userUID: number
  ): Promise<void> {
    await this.writer()("Vendors.VendorTbl_Lang")
      .insert({ VendorUID: vendorUID, LangCode: langCode, ...text, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["VendorUID", "LangCode"])
      .merge(["Name", "ContactPerson", "Notes", "Area", "CompanyName", "UpdatedBy"]);
  }

  // saveVendAddrLangRow — translated address text (one row per address and language).
  async saveAddressLangRow(
    vendAddressUID: number,
    langCode: string,
    text: { Line1: string | null; Line2: string | null; CityText: string | null; StateText: string | null },
    userUID: number
  ): Promise<void> {
    await this.writer()("Vendors.VendAddressTbl_Lang")
      .insert({ VendAddressUID: vendAddressUID, LangCode: langCode, ...text, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["VendAddressUID", "LangCode"])
      .merge(["Line1", "Line2", "CityText", "StateText", "UpdatedBy"]);
  }

  // Shared by the count and the data query, so both always use the same conditions.
  private applyListFilters(query: Knex.QueryBuilder, orgUID: number, filter: VendorListFilterDto): Knex.QueryBuilder {
    query.where({ "Vendors.IsDeleted": 0, "Vendors.OrgUID": orgUID });
    if (filter.SearchAllData) this.whereAnyLike(query, LIST_SEARCH_COLUMNS, filter.SearchAllData);
    if (filter.IsActive !== undefined) query.where("Vendors.IsActive", filter.IsActive);
    if (filter.UpdatedByUIDs?.length) query.whereIn("Vendors.UpdatedBy", filter.UpdatedByUIDs);
    if (filter.BalanceType) {
      // To collect (Debit) / to pay (Credit): vendors with a non-zero closing balance of that type
      const balanceType = filter.BalanceType;
      query.whereIn("Vendors.VendorUID", (sub) => {
        sub
          .select("VendorUID")
          .from("Vendors.VendOpeningBalanceTbl")
          .where({ OrgUID: orgUID, PendingBalType: balanceType, IsDeleted: 0 })
          .where("PendingBalance", ">", 0);
      });
    }
    return query;
  }

  // First image as PrimaryImageUrl and the full gallery as AttachmentsJson, fetched in one query for the page.
  private async attachPreviews(rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const vendorUIDs = rows.map((row) => toInt(row.VendorUID));
    const attachments: { VendorUID: string; FilePath: string; FileName: string }[] = await this.read("Vendors.VendorAttachmentsTbl")
      .select("VendorUID", "FilePath", "FileName")
      .whereIn("VendorUID", vendorUIDs)
      .where({ IsDeleted: 0 })
      .orderBy([
        { column: "VendorUID", order: "asc" },
        { column: "SortOrder", order: "asc" },
      ]);

    const gallery = new Map<number, { url: string; name: string }[]>();
    for (const attachment of attachments) {
      const uid = toInt(attachment.VendorUID);
      const list = gallery.get(uid) ?? [];
      list.push({ url: resolveCdnUrl(attachment.FilePath), name: attachment.FileName });
      gallery.set(uid, list);
    }
    for (const row of rows) {
      const list = gallery.get(toInt(row.VendorUID)) ?? [];
      row.PrimaryImageUrl = list[0]?.url ?? null;
      row.AttachmentsJson = JSON.stringify(list);
    }
  }
}
