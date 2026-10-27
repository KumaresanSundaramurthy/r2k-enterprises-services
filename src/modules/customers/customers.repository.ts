import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { resolveCdnUrl, toInt } from "../../common/utils/php-compat";
import { CustomerListFilterDto } from "./dto/customer-list.dto";

export type Row = Record<string, string | null>;

export interface CustomerListResult {
  rows: Row[];
  totalCount: number;
}

// Columns searched by the list page and the search list (CI3 SearchAllData)
const LIST_SEARCH_COLUMNS = ["Customers.Name", "Customers.Area", "Customers.MobileNumber", "Customers.ContactPerson"];
// Columns searched by the typeahead (CI3 getCustomersDetails)
const TYPEAHEAD_SEARCH_COLUMNS = ["Customers.Name", "Customers.Area", "Customers.MobileNumber"];

// Queries only (CI3 Customers_model). Every table is schema-qualified; no default database.
@Injectable()
export class CustomersRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getCustomerListPaginated — count + page of rows, with translations and attachment previews.
  async listPaginated(
    orgUID: number,
    pageNo: number,
    limit: number,
    filter: CustomerListFilterDto,
    langCode: string
  ): Promise<CustomerListResult> {
    const countRow = await this.applyListFilters(this.read("Customers.CustomerTbl as Customers").count({ cnt: "*" }), orgUID, filter).first();
    const totalCount = toInt(countRow?.cnt);

    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Customers.CustomerTbl as Customers")
      .select(
        "Customers.CustomerUID as TablePrimaryUID",
        "Customers.CustomerUID as CustomerUID",
        "Customers.OrgUID as OrgUID",
        "Customers.SalutationUID as SalutationUID",
        "Sal.SalutationName as SalutationName",
        this.langColumn(useLang, "CL.Name", "Customers.Name", "Name"),
        this.langColumn(useLang, "CL.Area", "Customers.Area", "Area"),
        "Customers.CountryISO2 as CountryISO2",
        "Customers.CountryCode as CountryCode",
        "Customers.MobileNumber as MobileNumber",
        "Customers.EmailAddress as EmailAddress",
        "Customers.GSTIN as GSTIN",
        "Customers.GSTINValidated as GSTINValidated",
        this.langColumn(useLang, "CL.CompanyName", "Customers.CompanyName", "CompanyName"),
        "Customers.DebitCreditType as DebitCreditType",
        "Customers.DebitCreditAmount as DebitCreditAmount",
        "Customers.Image as Image",
        "Customers.PANNumber as PANNumber",
        this.langColumn(useLang, "CL.ContactPerson", "Customers.ContactPerson", "ContactPerson"),
        "Customers.DateOfBirth as DateOfBirth",
        "Customers.DiscountPercent as DiscountPercent",
        "Customers.CreditPeriod as CreditPeriod",
        "Customers.CreditLimit as CreditLimit",
        this.langColumn(useLang, "CL.Notes", "Customers.Notes", "Notes"),
        "Customers.Tags as Tags",
        "Customers.CCEmails as CCEmails",
        "Customers.CustomerTypeUID as CustomerTypeUID",
        "Customers.IsActive as IsActive",
        "Customers.CreatedOn as CreatedOn",
        "Customers.UpdatedOn as UpdatedOn",
        this.read.raw("CONCAT(??, ' ', ??) AS ??", ["User.FirstName", "User.LastName", "UpdatedBy"]),
        this.read.raw("IFNULL(??, 0.00) AS ??", ["COB.PendingBalance", "ClosingBalance"]),
        this.read.raw("IFNULL(??, 'Debit') AS ??", ["COB.PendingBalType", "ClosingBalanceType"]),
        "CT.TypeName as CustomerTypeName",
        this.langColumn(useLang, "CAL.Line1", "ShipAddr.Line1", "ShipLine1"),
        this.langColumn(useLang, "CAL.Line2", "ShipAddr.Line2", "ShipLine2"),
        this.langColumn(useLang, "CAL.CityText", "ShipAddr.CityText", "ShipCity"),
        this.langColumn(useLang, "CAL.StateText", "ShipAddr.StateText", "ShipState"),
        "ShipAddr.Pincode as ShipPincode"
      )
      .leftJoin("Users.UserTbl as User", "User.UserUID", "Customers.UpdatedBy")
      .leftJoin("Customers.CustomerTypeTbl as CT", (on) => {
        on.on("CT.CustomerTypeUID", "Customers.CustomerTypeUID").andOnVal("CT.IsDeleted", "=", 0);
      })
      .leftJoin("Customers.CustAddressTbl as ShipAddr", (on) => {
        on.on("ShipAddr.CustomerUID", "Customers.CustomerUID")
          .andOnVal("ShipAddr.AddressType", "=", "Shipping")
          .andOnVal("ShipAddr.IsDeleted", "=", 0)
          .andOnVal("ShipAddr.IsActive", "=", 1);
      })
      .leftJoin("Customers.CustOpeningBalanceTbl as COB", (on) => {
        on.on("COB.CustomerUID", "Customers.CustomerUID").andOn("COB.OrgUID", "Customers.OrgUID").andOnVal("COB.IsDeleted", "=", 0);
      })
      .leftJoin("Global.SalutationTbl as Sal", (on) => {
        on.on("Sal.SalutationUID", "Customers.SalutationUID").andOnVal("Sal.IsDeleted", "=", 0);
      });
    if (useLang) {
      query
        .leftJoin("Customers.CustomersTbl_Lang as CL", (on) => {
          on.on("CL.CustomerUID", "Customers.CustomerUID").andOnVal("CL.LangCode", "=", langCode);
        })
        .leftJoin("Customers.CustAddressTbl_Lang as CAL", (on) => {
          on.on("CAL.CustAddressUID", "ShipAddr.CustAddressUID").andOnVal("CAL.LangCode", "=", langCode);
        });
    }
    this.applyListFilters(query, orgUID, filter);

    if (filter.NameSorting) query.orderBy("Customers.Name", filter.NameSorting === 1 ? "asc" : "desc");
    else if (filter.AreaSorting) query.orderBy("Customers.Area", filter.AreaSorting === 1 ? "asc" : "desc");
    else if (filter.BalanceSorting) query.orderBy("ClosingBalance", filter.BalanceSorting === 1 ? "asc" : "desc");
    else query.orderBy("Customers.CustomerUID", "desc");
    if (limit > 0) query.limit(limit).offset(BaseRepository.offset(pageNo, limit));

    const rows: Row[] = await query;
    await this.attachPreviews(rows);
    return { rows, totalCount };
  }

  // getCustomers — one customer with its opening balance and group membership.
  async findDetail(orgUID: number, customerUID: number, langCode: string): Promise<Row | null> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Customers.CustomerTbl as Customers")
      .select(
        "Customers.CustomerUID as CustomerUID",
        "Customers.OrgUID as OrgUID",
        "Customers.SalutationUID as SalutationUID",
        this.langColumn(useLang, "CL.Name", "Customers.Name", "Name"),
        this.langColumn(useLang, "CL.Area", "Customers.Area", "Area"),
        "Customers.CountryISO2 as CountryISO2",
        "Customers.CountryCode as CountryCode",
        "Customers.MobileNumber as MobileNumber",
        "Customers.EmailAddress as EmailAddress",
        "Customers.GSTIN as GSTIN",
        this.langColumn(useLang, "CL.CompanyName", "Customers.CompanyName", "CompanyName"),
        "Customers.WorkPhone as WorkPhone",
        "Customers.LandlineNumber as LandlineNumber",
        "Customers.DebitCreditType as DebitCreditType",
        "Customers.DebitCreditAmount as DebitCreditAmount",
        "Customers.Image as Image",
        "Customers.PANNumber as PANNumber",
        this.langColumn(useLang, "CL.ContactPerson", "Customers.ContactPerson", "ContactPerson"),
        "Customers.DateOfBirth as DateOfBirth",
        "Customers.DiscountPercent as DiscountPercent",
        "Customers.CreditPeriod as CreditPeriod",
        "Customers.CreditLimit as CreditLimit",
        this.langColumn(useLang, "CL.Notes", "Customers.Notes", "Notes"),
        "Customers.Tags as Tags",
        "Customers.CCEmails as CCEmails",
        "Customers.AllowPortalAccess as AllowPortalAccess",
        "Customers.CustomerTypeUID as CustomerTypeUID",
        "CGM.GroupUID as GroupUID",
        this.read.raw("COALESCE(??, 0) AS ??", ["CGM.IsGroupPrimary", "IsGroupPrimary"]),
        "Customers.CreatedOn as CreatedOn",
        "Customers.CustomerNumber as CustomerNumber",
        "Customers.UpdatedOn as UpdatedOn",
        // Opening balance from CustOpeningBalanceTbl (source of truth), falling back to the customer row
        this.read.raw("COALESCE(??, ??) AS ??", ["COB.OpeningBalance", "Customers.DebitCreditAmount", "OpeningBalance"]),
        this.read.raw("COALESCE(??, ??, 'Debit') AS ??", ["COB.OpeningBalType", "Customers.DebitCreditType", "OpeningBalType"])
      )
      .leftJoin("Customers.CustOpeningBalanceTbl as COB", (on) => {
        on.on("COB.CustomerUID", "Customers.CustomerUID").andOn("COB.OrgUID", "Customers.OrgUID").andOnVal("COB.IsDeleted", "=", 0);
      })
      .leftJoin("Customers.CustGroupMemberTbl as CGM", (on) => {
        on.on("CGM.CustomerUID", "Customers.CustomerUID").andOn("CGM.OrgUID", "Customers.OrgUID").andOnVal("CGM.IsDeleted", "=", 0);
      })
      .where({
        "Customers.CustomerUID": customerUID,
        "Customers.OrgUID": orgUID,
        "Customers.IsDeleted": 0,
        "Customers.IsActive": 1,
      });
    if (useLang) {
      query.leftJoin("Customers.CustomersTbl_Lang as CL", (on) => {
        on.on("CL.CustomerUID", "Customers.CustomerUID").andOnVal("CL.LangCode", "=", langCode);
      });
    }
    const row = await query.first();
    return row ?? null;
  }

  // getCustomerAddress — billing and shipping rows.
  async findAddresses(customerUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Customers.CustAddressTbl as CustAddress")
      .select(
        "CustAddress.CustAddressUID as CustAddressUID",
        "CustAddress.OrgUID as OrgUID",
        "CustAddress.CustomerUID as CustomerUID",
        "CustAddress.AddressType as AddressType",
        this.langColumn(useLang, "CAL.Line1", "CustAddress.Line1", "Line1"),
        this.langColumn(useLang, "CAL.Line2", "CustAddress.Line2", "Line2"),
        "CustAddress.Pincode as Pincode",
        "CustAddress.City as City",
        this.langColumn(useLang, "CAL.CityText", "CustAddress.CityText", "CityText"),
        "CustAddress.State as State",
        this.langColumn(useLang, "CAL.StateText", "CustAddress.StateText", "StateText")
      )
      .where({ "CustAddress.CustomerUID": customerUID, "CustAddress.IsDeleted": 0, "CustAddress.IsActive": 1 });
    if (useLang) {
      query.leftJoin("Customers.CustAddressTbl_Lang as CAL", (on) => {
        on.on("CAL.CustAddressUID", "CustAddress.CustAddressUID").andOnVal("CAL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getCustomerBankInfo
  async findBankDetails(customerUID: number): Promise<Row[]> {
    return this.read("Customers.CustBankDetailsTbl as CustBankDetails")
      .select(
        "CustBankDetails.CustBankDetUID as CustBankDetUID",
        "CustBankDetails.CustomerUID as CustomerUID",
        "CustBankDetails.Type as Type",
        "CustBankDetails.BankAccountNumber as BankAccountNumber",
        "CustBankDetails.BankIFSC_Code as BankIFSC_Code",
        "CustBankDetails.BankBranchName as BankBranchName",
        "CustBankDetails.BankAccountHolderName as BankAccountHolderName",
        "CustBankDetails.UPI_Id as UPI_Id"
      )
      .where({ "CustBankDetails.CustomerUID": customerUID, "CustBankDetails.IsDeleted": 0, "CustBankDetails.IsActive": 1 });
  }

  // getCustomerAttachments — each row also gets its CDN Url.
  async findAttachments(orgUID: number, customerUID: number): Promise<Row[]> {
    const rows: Row[] = await this.read("Customers.CustomerAttachmentsTbl")
      .select("AttachUID", "FileName", "FilePath", "FileSize", "SortOrder", "CreatedOn")
      .where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("SortOrder", "asc");
    return rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath) }));
  }

  // getCustomersDetails — typeahead, max 10 active customers.
  async searchByTerm(orgUID: number, term: string, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Customers.CustomerTbl as Customers")
      .select(
        "Customers.CustomerUID as CustomerUID",
        this.langColumn(useLang, "CL.Name", "Customers.Name", "Name"),
        this.langColumn(useLang, "CL.Area", "Customers.Area", "Area")
      )
      .where({ "Customers.OrgUID": orgUID, "Customers.IsDeleted": 0, "Customers.IsActive": 1 })
      .limit(10);
    this.whereAnyLike(query, TYPEAHEAD_SEARCH_COLUMNS, term);
    if (useLang) {
      query.leftJoin("Customers.CustomersTbl_Lang as CL", (on) => {
        on.on("CL.CustomerUID", "Customers.CustomerUID").andOnVal("CL.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getCustomersInOtherGroups — customers already linked to a group other than excludeGroupUID.
  async findCustomerUIDsInOtherGroups(orgUID: number, excludeGroupUID: number): Promise<number[]> {
    const query = this.read("Customers.CustGroupMemberTbl").select("CustomerUID").where({ OrgUID: orgUID, IsDeleted: 0 });
    if (excludeGroupUID > 0) query.whereNot({ GroupUID: excludeGroupUID });
    const rows: { CustomerUID: string }[] = await query;
    return rows.map((row) => toInt(row.CustomerUID));
  }

  // getCustomerTags — distinct tags across active customers, in first-seen order.
  async findTags(orgUID: number): Promise<string[]> {
    const rows: { Tags: string }[] = await this.read("Customers.CustomerTbl as Customers")
      .select("Customers.Tags as Tags")
      .where({ "Customers.OrgUID": orgUID, "Customers.IsDeleted": 0, "Customers.IsActive": 1 })
      .whereNotNull("Customers.Tags")
      .whereNot("Customers.Tags", "");
    const tags = new Set<string>();
    for (const row of rows) {
      for (const tag of row.Tags.split(",")) {
        const trimmed = tag.trim();
        if (trimmed) tags.add(trimmed);
      }
    }
    return [...tags];
  }

  // getCustomerStats — totals for the list page header (dates are YYYY-MM-DD, UTC like CI3's date()).
  async stats(orgUID: number, period: { monthStart: string; nextMonthStart: string; lastMonthStart: string; fyStart: string }): Promise<Row | null> {
    const raw = (sql: string, bindings: (string | number)[]) => this.read.raw(sql, bindings);
    const row = await this.read("Customers.CustomerTbl as C")
      .select(
        raw("COUNT(??) AS ??", ["C.CustomerUID", "TotalCount"]),
        raw("SUM(CASE WHEN ?? = 1 THEN 1 ELSE 0 END) AS ??", ["C.IsActive", "ActiveCount"]),
        raw("SUM(CASE WHEN ?? >= ? AND ?? < ? THEN 1 ELSE 0 END) AS ??", ["C.CreatedOn", period.monthStart, "C.CreatedOn", period.nextMonthStart, "MonthCount"]),
        raw("SUM(CASE WHEN ?? >= ? THEN 1 ELSE 0 END) AS ??", ["C.CreatedOn", period.fyStart, "FYCount"]),
        raw("SUM(CASE WHEN ?? >= ? AND ?? < ? THEN 1 ELSE 0 END) AS ??", ["C.CreatedOn", period.lastMonthStart, "C.CreatedOn", period.monthStart, "LastMonthCount"]),
        // To collect: customers who owe us (Debit balance)
        raw("SUM(CASE WHEN ?? = 'Debit' AND ?? > 0 THEN 1 ELSE 0 END) AS ??", ["COB.PendingBalType", "COB.PendingBalance", "ToCollectCount"]),
        raw("COALESCE(SUM(CASE WHEN ?? = 'Debit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", [
          "COB.PendingBalType",
          "COB.PendingBalance",
          "COB.PendingBalance",
          "ToCollectAmount",
        ]),
        // To pay: we owe the customer (Credit balance)
        raw("SUM(CASE WHEN ?? = 'Credit' AND ?? > 0 THEN 1 ELSE 0 END) AS ??", ["COB.PendingBalType", "COB.PendingBalance", "ToPayCount"]),
        raw("COALESCE(SUM(CASE WHEN ?? = 'Credit' AND ?? > 0 THEN ?? ELSE 0 END), 0) AS ??", [
          "COB.PendingBalType",
          "COB.PendingBalance",
          "COB.PendingBalance",
          "ToPayAmount",
        ])
      )
      .leftJoin("Customers.CustOpeningBalanceTbl as COB", (on) => {
        on.on("COB.CustomerUID", "C.CustomerUID").andOn("COB.OrgUID", "C.OrgUID").andOnVal("COB.IsDeleted", "=", 0);
      })
      .where({ "C.IsDeleted": 0, "C.OrgUID": orgUID })
      .first();
    return row ?? null;
  }

  // getCustomerOpeningBalance — opening + current closing balance row.
  async findOpeningBalance(orgUID: number, customerUID: number): Promise<Row | null> {
    const row = await this.read("Customers.CustOpeningBalanceTbl")
      .select("OpeningBalUID", "OpeningBalance", "OpeningBalType", "PendingBalance", "PendingBalType", "Notes")
      .where({ OrgUID: orgUID, CustomerUID: customerUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getCustomerYearOpening — opening balance snapshot for one financial year.
  async findYearOpening(orgUID: number, customerUID: number, financialYear: number): Promise<Row | null> {
    const row = await this.read("Customers.CustYearOpeningBalanceTbl")
      .select("YearBalUID", "FinancialYear", "OpeningBalance", "OpeningBalType")
      .where({ OrgUID: orgUID, CustomerUID: customerUID, FinancialYear: financialYear, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getCustomerOnAccountPayments — unapplied payments, oldest first (FIFO).
  async findOnAccountPayments(orgUID: number, customerUID: number): Promise<Row[]> {
    return this.read("Transaction.PaymentsTbl as P")
      .select(
        "P.PaymentUID as PaymentUID",
        "P.Amount as Amount",
        "P.CreatedOn as CreatedOn",
        "P.Notes as Notes",
        "T.UniqueNumber as SourceInvoiceNumber",
        "T.NetAmount as SourceInvoiceAmount",
        "T.TransDate as SourceInvoiceDate"
      )
      .leftJoin("Transaction.TransactionsTbl as T", "T.TransUID", "P.TransUID")
      .where({
        "P.OrgUID": orgUID,
        "P.PartyUID": customerUID,
        "P.PartyType": "C",
        "P.PaymentDirection": "In",
        "P.IsOnAccount": 1,
        "P.IsDeleted": 0,
        "P.IsCancelled": 0,
      })
      .orderBy("P.CreatedOn", "asc");
  }

  // getCustomerTypesFromDB — global customer types (not per organisation).
  async findCustomerTypes(): Promise<Row[]> {
    return this.read("Customers.CustomerTypeTbl as CT")
      .select("CT.CustomerTypeUID as CustomerTypeUID", "CT.TypeName as TypeName", "CT.IsDefault as IsDefault")
      .where({ "CT.IsDeleted": 0, "CT.IsActive": 1 })
      .orderBy("CT.CustomerTypeUID", "asc");
  }

  // getEntityWithLedger — the customer (deleted or not) with its linked ledger.
  async findWithLedger(orgUID: number, customerUID: number, trx?: Knex.Transaction): Promise<Row | null> {
    const row = await (trx ?? this.read)("Customers.CustomerTbl as c")
      .select(
        "c.CustomerUID as CustomerUID",
        "c.Name as EntityName",
        "c.IsDeleted as IsDeleted",
        "c.IsActive as IsActive",
        "el.LedgerUID as LedgerUID",
        "ca.LedgerCode as LedgerCode",
        "ca.LedgerName as LedgerName",
        "ca.OpeningBalance as OpeningBalance",
        "ca.OpeningBalanceType as OpeningBalanceType",
        "ca.ParentLedgerUID as ParentLedgerUID"
      )
      .leftJoin("Accounting.EntityLedgerMap as el", (on) => {
        on.on("el.CustomerUID", "c.CustomerUID").andOnVal("el.EntityType", "=", "Customer");
      })
      .leftJoin("Accounting.ChartOfAccounts as ca", (on) => {
        on.on("ca.LedgerUID", "el.LedgerUID").andOnVal("ca.IsDeleted", "=", 0);
      })
      .where({ "c.CustomerUID": customerUID, "c.OrgUID": orgUID })
      .first();
    return row ?? null;
  }

  // getCustomerDebitCreditRaw — values before an update (name change detection and audit).
  async findDebitCreditRaw(orgUID: number, customerUID: number): Promise<Row | null> {
    const row = await this.read("Customers.CustomerTbl")
      .select("Name", "DebitCreditAmount", "DebitCreditType")
      .where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // customerHasTransactions (Transactions_model::getEntityInvoices) — any active transaction with this customer.
  async hasTransactions(orgUID: number, customerUID: number): Promise<boolean> {
    const row = await this.read("Transaction.TransactionsTbl")
      .select("TransUID")
      .where({ OrgUID: orgUID, PartyUID: customerUID, PartyType: "C", IsDeleted: 0, IsActive: 1 })
      .first();
    return !!row;
  }

  // getCustomerUIDsByFilter — every customer the list filter matches (bulk "select all").
  async findUIDsByFilter(orgUID: number, filter: CustomerListFilterDto): Promise<number[]> {
    const rows: { CustomerUID: string }[] = await this.applyListFilters(
      this.read("Customers.CustomerTbl as Customers").select("Customers.CustomerUID as CustomerUID"),
      orgUID,
      filter
    );
    return rows.map((row) => toInt(row.CustomerUID));
  }

  // getCustomerGroupMembership
  async findGroupMembership(orgUID: number, customerUID: number): Promise<Row | null> {
    const row = await this.read("Customers.CustGroupMemberTbl")
      .select("MemberUID", "GroupUID", "IsGroupPrimary")
      .where({ OrgUID: orgUID, CustomerUID: customerUID, IsDeleted: 0 })
      .first();
    return row ?? null;
  }

  // getAllCustomerUIDs — every non-deleted customer of the organisation
  async findAllUIDs(orgUID: number): Promise<number[]> {
    const rows: { CustomerUID: string }[] = await this.read("Customers.CustomerTbl")
      .select("CustomerUID")
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("CustomerUID", "asc");
    return rows.map((row) => toInt(row.CustomerUID));
  }

  // Active customers of the organisation (CI3 getCustomers filter: IsDeleted = 0, IsActive = 1)
  async findActiveUIDs(orgUID: number): Promise<number[]> {
    const rows: { CustomerUID: string }[] = await this.read("Customers.CustomerTbl")
      .select("CustomerUID")
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy("CustomerUID", "asc");
    return rows.map((row) => toInt(row.CustomerUID));
  }

  // Active billing address of a customer (CI3 getCustomerAddress with AddressType = Billing)
  async findBillingAddressUID(orgUID: number, customerUID: number): Promise<number | null> {
    const row = await this.read("Customers.CustAddressTbl")
      .select("CustAddressUID")
      .where({ CustomerUID: customerUID, OrgUID: orgUID, AddressType: "Billing", IsDeleted: 0, IsActive: 1 })
      .first();
    return row ? toInt(row.CustAddressUID) : null;
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  // updateBillingAddress — updates the billing row, or inserts it when the customer has none.
  async saveBillingAddress(existingUID: number | null, row: Record<string, unknown>, userUID: number): Promise<void> {
    if (existingUID) {
      await this.writer()("Customers.CustAddressTbl").where({ CustAddressUID: existingUID }).update(row);
    } else {
      await this.writer()("Customers.CustAddressTbl").insert({ ...row, CreatedBy: userUID });
    }
  }

  // saveCustomerNote
  async insertNote(orgUID: number, customerUID: number, note: string, userUID: number): Promise<void> {
    await this.writer()("Customers.CustomerNotesTbl").insert({ OrgUID: orgUID, CustomerUID: customerUID, Note: note, UserUID: userUID, IsDeleted: 0 });
  }

  // Soft delete (CI3 baseDeleteArrayDetails: IsDeleted = 1, UpdatedBy)
  async softDelete(trx: Knex.Transaction, orgUID: number, customerUIDs: number[], userUID: number): Promise<void> {
    await trx("Customers.CustomerTbl").where({ OrgUID: orgUID }).whereIn("CustomerUID", customerUIDs).update({ IsDeleted: 1, UpdatedBy: userUID });
  }

  async setActive(orgUID: number, customerUID: number, isActive: number, userUID: number): Promise<number> {
    return this.writer()("Customers.CustomerTbl")
      .where({ CustomerUID: customerUID, OrgUID: orgUID })
      .update({ IsActive: isActive, UpdatedBy: userUID });
  }

  // removeCustomerFromGroup
  async removeFromGroup(orgUID: number, customerUID: number, userUID: number): Promise<void> {
    await this.writer()("Customers.CustGroupMemberTbl")
      .where({ OrgUID: orgUID, CustomerUID: customerUID, IsDeleted: 0 })
      .update({ IsDeleted: 1, UpdatedBy: userUID });
  }

  async insertCustomer(trx: Knex.Transaction, row: Record<string, unknown>): Promise<number> {
    const [customerUID] = await trx("Customers.CustomerTbl").insert(row);
    return customerUID;
  }

  // getAttachmentSortStats — highest SortOrder, count and total size of the customer's attachments
  async attachmentStats(orgUID: number, customerUID: number) {
    const row = await this.read("Customers.CustomerAttachmentsTbl")
      .select(
        this.read.raw("COALESCE(MAX(??), 0) AS ??", ["SortOrder", "maxSort"]),
        this.read.raw("COUNT(*) AS ??", ["count"]),
        this.read.raw("COALESCE(SUM(??), 0) AS ??", ["FileSize", "totalSize"])
      )
      .where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return { maxSort: toInt(row?.maxSort), count: toInt(row?.count), totalSize: Number(row?.totalSize ?? 0) };
  }

  // getCustomerPrimaryImage — FilePath of the first attachment, or null
  async findPrimaryImage(orgUID: number, customerUID: number): Promise<string | null> {
    const row = await this.read("Customers.CustomerAttachmentsTbl")
      .select("FilePath")
      .where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 })
      .orderBy("SortOrder", "asc")
      .first();
    return row?.FilePath ?? null;
  }

  async insertAttachment(row: Record<string, unknown>): Promise<void> {
    await this.writer()("Customers.CustomerAttachmentsTbl").insert(row);
  }

  // Soft-deletes attachments of the organisation; customerUID 0 = any customer (CI3 deleteCustomerAttachment)
  async softDeleteAttachments(orgUID: number, customerUID: number, attachUIDs: number[], userUID: number): Promise<number> {
    if (attachUIDs.length === 0) return 0;
    const query = this.writer()("Customers.CustomerAttachmentsTbl")
      .whereIn("AttachUID", attachUIDs)
      .where({ OrgUID: orgUID, IsDeleted: 0 });
    if (customerUID > 0) query.where({ CustomerUID: customerUID });
    return query.update({ IsDeleted: 1, IsActive: 0, UpdatedBy: userUID });
  }

  async updateCustomer(customerUID: number, data: Record<string, unknown>, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)("Customers.CustomerTbl").where({ CustomerUID: customerUID }).update(data);
  }

  /**
   * saveCustomerOpeningBalance — updates the existing row, or inserts one (closing balance starts equal
   * to opening). `notes` undefined leaves Notes untouched on update (the edit-customer form has no notes).
   */
  async saveOpeningBalance(
    trx: Knex.Transaction,
    orgUID: number,
    customerUID: number,
    amount: number,
    type: string,
    notes: string | null | undefined,
    userUID: number,
    isNew: boolean
  ): Promise<number> {
    if (!isNew) {
      const existing = await trx("Customers.CustOpeningBalanceTbl")
        .select("OpeningBalUID")
        .where({ OrgUID: orgUID, CustomerUID: customerUID, IsDeleted: 0 })
        .first();
      if (existing) {
        await trx("Customers.CustOpeningBalanceTbl")
          .where({ OpeningBalUID: existing.OpeningBalUID })
          .update({
            OpeningBalance: amount,
            OpeningBalType: type,
            ...(notes !== undefined ? { Notes: notes || null } : {}),
            UpdatedBy: userUID,
          });
        return toInt(existing.OpeningBalUID);
      }
    }
    const [openingBalUID] = await trx("Customers.CustOpeningBalanceTbl").insert({
      OrgUID: orgUID,
      CustomerUID: customerUID,
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
    return openingBalUID;
  }

  // saveCustomerYearOpening — onlyIfNew keeps an existing year-start snapshot untouched.
  async saveYearOpening(
    trx: Knex.Transaction,
    orgUID: number,
    customerUID: number,
    financialYear: number,
    amount: number,
    type: string,
    userUID: number,
    options: { onlyIfNew?: boolean; isNew?: boolean } = {}
  ): Promise<void> {
    if (!options.isNew) {
      const existing = await trx("Customers.CustYearOpeningBalanceTbl")
        .select("YearBalUID")
        .where({ OrgUID: orgUID, CustomerUID: customerUID, FinancialYear: financialYear, IsDeleted: 0 })
        .first();
      if (existing) {
        if (options.onlyIfNew) return;
        await trx("Customers.CustYearOpeningBalanceTbl")
          .where({ YearBalUID: existing.YearBalUID })
          .update({ OpeningBalance: amount, OpeningBalType: type, UpdatedBy: userUID });
        return;
      }
    }
    await trx("Customers.CustYearOpeningBalanceTbl").insert({
      OrgUID: orgUID,
      CustomerUID: customerUID,
      FinancialYear: financialYear,
      OpeningBalance: amount,
      OpeningBalType: type,
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: userUID,
      UpdatedBy: userUID,
    });
  }

  // saveLangRow — translated customer text (one row per customer and language).
  async saveLangRow(
    customerUID: number,
    langCode: string,
    text: { Name: string; ContactPerson: string | null; Notes: string | null; Area: string | null; CompanyName: string | null },
    userUID: number
  ): Promise<void> {
    await this.writer()("Customers.CustomersTbl_Lang")
      .insert({ CustomerUID: customerUID, LangCode: langCode, ...text, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["CustomerUID", "LangCode"])
      .merge(["Name", "ContactPerson", "Notes", "Area", "CompanyName", "UpdatedBy"]);
  }

  // saveAddrLangRow — translated address text (one row per address and language).
  async saveAddressLangRow(
    custAddressUID: number,
    langCode: string,
    text: { Line1: string | null; Line2: string | null; CityText: string | null; StateText: string | null },
    userUID: number
  ): Promise<void> {
    await this.writer()("Customers.CustAddressTbl_Lang")
      .insert({ CustAddressUID: custAddressUID, LangCode: langCode, ...text, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["CustAddressUID", "LangCode"])
      .merge(["Line1", "Line2", "CityText", "StateText", "UpdatedBy"]);
  }

  // saveCustomerGroupMembership — one membership per customer (unique OrgUID + CustomerUID).
  async saveGroupMembership(orgUID: number, customerUID: number, groupUID: number, isGroupPrimary: number, userUID: number): Promise<void> {
    await this.writer()("Customers.CustGroupMemberTbl")
      .insert({
        OrgUID: orgUID,
        CustomerUID: customerUID,
        GroupUID: groupUID,
        IsGroupPrimary: isGroupPrimary,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      })
      .onConflict(["OrgUID", "CustomerUID"])
      .merge({ GroupUID: groupUID, IsGroupPrimary: isGroupPrimary, IsDeleted: 0, UpdatedBy: userUID });
  }

  // Shared by the count and the data query, so both always use the same conditions.
  private applyListFilters(query: Knex.QueryBuilder, orgUID: number, filter: CustomerListFilterDto): Knex.QueryBuilder {
    query.where({ "Customers.IsDeleted": 0, "Customers.OrgUID": orgUID });
    if (filter.IsActive !== undefined) query.where("Customers.IsActive", filter.IsActive);
    if (filter.SearchAllData) this.whereAnyLike(query, LIST_SEARCH_COLUMNS, filter.SearchAllData);
    if (filter.Tags?.length) this.whereLikeAnyOf(query, "Customers.Tags", filter.Tags);
    if (filter.CustomerTypeUIDs?.length) query.whereIn("Customers.CustomerTypeUID", filter.CustomerTypeUIDs);
    if (filter.UpdatedByUIDs?.length) query.whereIn("Customers.UpdatedBy", filter.UpdatedByUIDs);
    if (filter.BalanceType) {
      // To collect (Debit) / to pay (Credit): customers with a non-zero closing balance of that type
      const balanceType = filter.BalanceType;
      query.whereIn("Customers.CustomerUID", (sub) => {
        sub
          .select("CustomerUID")
          .from("Customers.CustOpeningBalanceTbl")
          .where({ OrgUID: orgUID, PendingBalType: balanceType, IsDeleted: 0 })
          .where("PendingBalance", ">", 0);
      });
    }
    return query;
  }

  // First image as PrimaryImageUrl and the full gallery as AttachmentsJson, fetched in one query for the page.
  private async attachPreviews(rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    const customerUIDs = rows.map((row) => toInt(row.CustomerUID));
    const attachments: { CustomerUID: string; FilePath: string; FileName: string }[] = await this.read(
      "Customers.CustomerAttachmentsTbl"
    )
      .select("CustomerUID", "FilePath", "FileName")
      .whereIn("CustomerUID", customerUIDs)
      .where({ IsDeleted: 0 })
      .orderBy([
        { column: "CustomerUID", order: "asc" },
        { column: "SortOrder", order: "asc" },
      ]);

    const gallery = new Map<number, { url: string; name: string }[]>();
    for (const attachment of attachments) {
      const uid = toInt(attachment.CustomerUID);
      const list = gallery.get(uid) ?? [];
      list.push({ url: resolveCdnUrl(attachment.FilePath), name: attachment.FileName });
      gallery.set(uid, list);
    }
    for (const row of rows) {
      const list = gallery.get(toInt(row.CustomerUID)) ?? [];
      row.PrimaryImageUrl = list[0]?.url ?? null;
      row.AttachmentsJson = JSON.stringify(list);
    }
  }
}
