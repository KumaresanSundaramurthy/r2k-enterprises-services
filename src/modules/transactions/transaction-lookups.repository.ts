import { Injectable } from "@nestjs/common";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

// GenSettings / TransSettings values the transaction pages read from CI3's session
export interface TransactionSettings {
  showStats: boolean;
  quotValidityDays: number;
  printDateFormat: string;
  currency: string;
  enableStorage: boolean;
}

/** Dropdowns, searches and print lookups of the transaction forms (CI3 Transactions / Organisation models). */
@Injectable()
export class TransactionLookupsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  async settings(orgUID: number): Promise<TransactionSettings> {
    const [general, transaction] = await Promise.all([
      this.read("Settings.OrgSettingsTbl").select("ShowStats", "PrintDateFormat", "CurrenySymbol", "EnableStorage").where({ OrgUID: orgUID }).first(),
      this.read("Settings.TransactionSettingsTbl").select("ShowTransactionStats", "QuotValidityDays").where({ OrgUID: orgUID }).first(),
    ]);
    return {
      showStats: Number(general?.ShowStats ?? 1) === 1 && Number(transaction?.ShowTransactionStats ?? 1) === 1,
      quotValidityDays: Number(transaction?.QuotValidityDays ?? 7) || 7,
      printDateFormat: general?.PrintDateFormat || "d M Y",
      currency: general?.CurrenySymbol || "₹",
      enableStorage: Number(general?.EnableStorage ?? 0) === 1,
    };
  }

  // getExpenseIncomeAttachments — files of an expense (Expense) or indirect income (IndirectIncome) record
  async entryAttachments(orgUID: number, sourceType: string, sourceUID: number): Promise<Row[]> {
    const rows: Row[] = await this.read("Transaction.ExpenseIncomeAttachmentsTbl")
      .select("AttachUID", "FileName", "FilePath", "FileType", "FileSize", "SortOrder")
      .where({ SourceUID: sourceUID, SourceType: sourceType, OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy("SortOrder", "asc");
    return rows.map((row) => ({ ...row, Url: resolveCdnUrl(row.FilePath as string) }));
  }

  // A live customer of the organisation
  async customerExists(orgUID: number, customerUID: number): Promise<boolean> {
    return !!(await this.read("Customers.CustomerTbl").select("CustomerUID").where({ CustomerUID: customerUID, OrgUID: orgUID, IsDeleted: 0 }).first());
  }

  // The vendor is one of the organisation's (CI3 accepted any VendorUID)
  async vendorExists(orgUID: number, vendorUID: number): Promise<boolean> {
    return !!(await this.read("Vendors.VendorTbl").select("VendorUID").where({ VendorUID: vendorUID, OrgUID: orgUID, IsDeleted: 0 }).first());
  }

  // getAllOrgDispatchAddresses — the organisation's shipping addresses
  async dispatchAddresses(orgUID: number): Promise<Row[]> {
    return this.read("Organisation.OrgAddressTbl as a")
      .select("a.OrgAddressUID", "a.OrgUID", "a.AddressType", "a.Line1", "a.Line2", "a.Pincode", "a.City", "a.CityText", "a.State", "a.StateText", "o.Name as OrgName")
      .leftJoin("Organisation.OrganisationTbl as o", "o.OrgUID", "a.OrgUID")
      .where({ "a.OrgUID": orgUID, "a.AddressType": "Shipping", "a.IsActive": 1, "a.IsDeleted": 0 })
      .orderBy("a.OrgAddressUID", "asc");
  }

  // getOrgDispatchAddress — the first shipping address, else the billing address
  async dispatchAddress(orgUID: number): Promise<Row | null> {
    for (const type of ["Shipping", "Billing"]) {
      const row = await this.read("Organisation.OrgAddressTbl as Addr")
        .select("Addr.OrgAddressUID", "Addr.OrgUID", "Addr.AddressType", "Addr.Line1", "Addr.Line2", "Addr.Pincode", "Addr.CityText", "Addr.StateText")
        .where({ "Addr.OrgUID": orgUID, "Addr.AddressType": type, "Addr.IsActive": 1, "Addr.IsDeleted": 0 })
        .first();
      if (row) return row;
    }
    return null;
  }

  // The address a document is dispatched from (TransactionsTbl.DispatchFrom)
  async addressByUID(orgUID: number, addressUID: number): Promise<Row | null> {
    return (await this.read("Organisation.OrgAddressTbl").select("Line1", "Line2", "CityText", "StateText", "Pincode").where({ OrgAddressUID: addressUID, OrgUID: orgUID }).first()) ?? null;
  }

  // getStorageDetails — the organisation's storage locations (CI3 listed every organisation's)
  async storages(orgUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Products.StorageTbl as Storage")
      .select(
        "Storage.StorageUID",
        "Storage.OrgUID",
        this.langColumn(useLang, "SL.Name", "Storage.Name", "Name"),
        this.langColumn(useLang, "SL.ShortName", "Storage.ShortName", "ShortName"),
        this.langColumn(useLang, "SL.Description", "Storage.Description", "Description"),
        "Storage.StorageTypeUID",
        "StorageType.Name as StorageTypeName",
        "Storage.Image",
        "Storage.CreatedOn",
        "Storage.UpdatedOn"
      )
      .leftJoin("Global.StorageTypeTbl as StorageType", "StorageType.StorageTypeUID", "Storage.StorageTypeUID")
      .where({ "Storage.OrgUID": orgUID, "Storage.IsDeleted": 0, "Storage.IsActive": 1 })
      .orderBy("Storage.StorageUID", "asc");
    if (useLang) query.leftJoin("Products.StorageTbl_Lang as SL", (on) => on.on("SL.StorageUID", "Storage.StorageUID").andOnVal("SL.LangCode", "=", langCode));
    return query;
  }

  // getModuleMessageTemplates — the module's templates by channel (Email, WhatsApp, …)
  async messageTemplates(orgUID: number, moduleUID: number): Promise<Record<string, Row>> {
    const rows: Row[] = await this.read("Settings.MessageTemplatesTbl").where({ OrgUID: orgUID, ModuleUID: moduleUID, IsDeleted: 0 });
    return Object.fromEntries(rows.map((row) => [String(row.Channel), row]));
  }

  // Userpreferences_model::getUserPreference
  async preference(orgUID: number, branchUID: number, userUID: number, key: string): Promise<string | null> {
    const row = await this.read("Users.UserPreferencesTbl").select("PreferenceValue").where({ OrgUID: orgUID, BranchUID: branchUID, UserUID: userUID, PreferenceKey: key }).first();
    return row?.PreferenceValue ?? null;
  }

  // Login users for the "updated by" filter (CI3 getOrgUsersForCache)
  async orgUsers(orgUID: number): Promise<Row[]> {
    return this.read("Users.UserTbl")
      .select("UserUID", "FirstName", "LastName", this.read.raw("CONCAT(FirstName, ' ', LastName) AS FullName"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1, HasLoginAccess: 1 })
      .orderBy("FirstName", "asc");
  }

  // getCustomersDetails — 10 live customers matching the term, with an address and balance (CI3 searched every organisation)
  async searchCustomers(orgUID: number, term: string, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const k = this.read;
    const query = k("Customers.CustomerTbl as Customers")
      .select(
        "Customers.CustomerUID",
        this.langColumn(useLang, "CL.Name", "Customers.Name", "Name"),
        this.langColumn(useLang, "CL.Area", "Customers.Area", "Area"),
        "Customers.MobileNumber",
        k.raw("MAX(COALESCE(Ship.CustAddressUID, Bill.CustAddressUID)) AS AddrUID"),
        k.raw("MAX(COALESCE(Ship.Line1, Bill.Line1)) AS Line1"),
        k.raw("MAX(COALESCE(Ship.Line2, Bill.Line2)) AS Line2"),
        k.raw("MAX(COALESCE(Ship.Pincode, Bill.Pincode)) AS Pincode"),
        k.raw("MAX(COALESCE(Ship.CityText, Bill.CityText)) AS CityText"),
        k.raw("MAX(COALESCE(Ship.StateText, Bill.StateText)) AS StateText"),
        k.raw("MAX(COALESCE(COA.CurrentBalance, 0)) AS CustomerBalance"),
        k.raw("MAX(COALESCE(COA.CurrentBalanceType, 'Debit')) AS BalanceType")
      )
      .leftJoin("Customers.CustAddressTbl as Bill", (on) => on.on("Bill.CustomerUID", "Customers.CustomerUID").andOnVal("Bill.IsDeleted", "=", 0).andOnVal("Bill.IsActive", "=", 1))
      .leftJoin("Customers.CustAddressTbl as Ship", (on) => on.on("Ship.CustomerUID", "Customers.CustomerUID").andOnVal("Ship.IsDeleted", "=", 0).andOnVal("Ship.IsActive", "=", 1))
      .leftJoin("Accounting.EntityLedgerMap as ELM", (on) =>
        on.on("ELM.CustomerUID", "Customers.CustomerUID").andOnVal("ELM.EntityType", "=", "Customer").andOnVal("ELM.IsDeleted", "=", 0)
      )
      .leftJoin("Accounting.ChartOfAccounts as COA", "COA.LedgerUID", "ELM.LedgerUID")
      .where({ "Customers.OrgUID": orgUID, "Customers.IsDeleted": 0, "Customers.IsActive": 1 })
      .groupBy("Customers.CustomerUID")
      .limit(10);
    if (useLang) query.leftJoin("Customers.CustomersTbl_Lang as CL", (on) => on.on("CL.CustomerUID", "Customers.CustomerUID").andOnVal("CL.LangCode", "=", langCode));
    if (term) {
      this.whereAnyLike(
        query,
        ["Customers.Name", "Customers.Area", "Customers.MobileNumber", "Customers.GSTIN", "Customers.CompanyName", "Customers.ContactPerson"],
        term
      );
    }
    return query;
  }

  // getTransProductsDetails — 30 live products matching the term, with stock, tax and unit (CI3 searched every organisation)
  async searchProducts(orgUID: number, term: string, categoryUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const k = this.read;
    const query = k("Products.ProductTbl as product")
      .select(
        "product.ProductUID",
        this.langColumn(useLang, "PL.ItemName", "product.ItemName", "ItemName"),
        "product.ProductType",
        "product.SellingPrice",
        "product.PurchasePrice",
        "product.MRP",
        "product.PurchasePriceProductTaxUID",
        "product.TaxPercentage",
        "product.CGST",
        "product.SGST",
        "product.IGST",
        "product.CategoryUID",
        this.langColumn(useLang, "CL.Name", "category.Name", "CatgName"),
        "product.HSNSACCode",
        k.raw("COALESCE(productStock.AvailableQty, 0) AS AvailableQuantity"),
        "product.Discount",
        "product.DiscountTypeUID",
        "discountType.Name as DiscountTypeName",
        "primaryUnit.ShortName as priUnitShortName",
        "product.PartNumber",
        "product.Description",
        "product.IsComboItem",
        "product.IsComposite",
        "product.IsBrandApplicable",
        k.raw("(SELECT COUNT(*) FROM Products.ProductBOMTbl pc WHERE pc.ParentProductUID = product.ProductUID AND pc.IsDeleted = 0 AND pc.IsActive = 1) AS ComboItemCount")
      )
      .leftJoin("Products.ProductStockTbl as productStock", "productStock.ProductUID", "product.ProductUID")
      .leftJoin("Products.CategoryTbl as category", (on) => on.on("category.CategoryUID", "product.CategoryUID").andOnVal("category.IsDeleted", "=", 0).andOnVal("category.IsActive", "=", 1))
      .leftJoin("Global.DiscountTypeTbl as discountType", (on) =>
        on.on("discountType.DiscountTypeUID", "product.DiscountTypeUID").andOnVal("discountType.IsDeleted", "=", 0).andOnVal("discountType.IsActive", "=", 1)
      )
      .leftJoin("Global.PrimaryUnitTbl as primaryUnit", "primaryUnit.PrimaryUnitUID", "product.PrimaryUnitUID")
      .where({ "product.OrgUID": orgUID, "product.IsDeleted": 0, "product.IsActive": 1 })
      .groupBy("product.ProductUID")
      .limit(30);
    if (useLang) {
      query
        .leftJoin("Products.ProductTbl_Lang as PL", (on) => on.on("PL.ProductUID", "product.ProductUID").andOnVal("PL.LangCode", "=", langCode))
        .leftJoin("Products.CategoryTbl_Lang as CL", (on) => on.on("CL.CategoryUID", "product.CategoryUID").andOnVal("CL.LangCode", "=", langCode));
    }
    if (term) this.whereAnyLike(query, ["product.ItemName", "product.PartNumber"], term);
    if (categoryUID > 0) query.where("product.CategoryUID", categoryUID);
    return query;
  }

  // getPrintThemeByModule — the module's print theme with its template HTML
  async printTheme(orgUID: number, moduleUID: number): Promise<Row | null> {
    const row = await this.read("Settings.PrintThemeConfigTbl as TC")
      .select("TC.*", "PT.HtmlContent as TemplateHtmlContent", "PT.PreviewImage as TemplatePreviewImage", "PT.TemplateName as TemplateName")
      .leftJoin("Settings.PrintTemplatesTbl as PT", (on) => on.on("PT.TemplateUID", "TC.TemplateUID").andOnVal("PT.IsDeleted", "=", 0))
      .where({ "TC.OrgUID": orgUID, "TC.ModuleUID": moduleUID, "TC.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // getThermalPrintConfigByModule
  async thermalConfig(orgUID: number, moduleUID: number): Promise<Row | null> {
    return (await this.read("Settings.ThermalPrintConfigTbl").where({ OrgUID: orgUID, ModuleUID: moduleUID, IsDeleted: 0 }).first()) ?? null;
  }

  // getPrintBankAccount — the default non-cash account, else any non-cash account
  async printBankAccount(orgUID: number): Promise<Row | null> {
    const row = await this.read("Organisation.OrgBankAccountsTbl")
      .select("BankAccountUID", "AccountName", "BankName", "AccountNumber", "IFSC", "BranchName", "UPIId", "UPINumber", "IsDefault", "IsCash")
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1, IsCash: 0 })
      .orderBy("IsDefault", "desc")
      .first();
    return row ?? null;
  }

  // A signature for the print (Users.UserSignaturesTbl)
  async signature(signatureUID: number): Promise<Row | null> {
    return (await this.read("Users.UserSignaturesTbl").select("SignatureUID", "Label", "SignatureType", "ImagePath", "DrawData", "MimeType").where({ SignatureUID: signatureUID, IsDeleted: 0 }).first()) ?? null;
  }

  // The party's closing balance for the print: customers from their stored balance, vendors from their ledger
  async partyBalance(orgUID: number, partyType: string, partyUID: number): Promise<{ balance: number; type: string } | null> {
    if (partyUID <= 0) return null;
    if (partyType === "C") {
      const row = await this.read("Customers.CustOpeningBalanceTbl").select("PendingBalance", "PendingBalType").where({ OrgUID: orgUID, CustomerUID: partyUID, IsDeleted: 0 }).first();
      return { balance: Number(row?.PendingBalance ?? 0), type: row?.PendingBalType ?? "Debit" };
    }
    if (partyType === "S") {
      const row = await this.read("Accounting.EntityLedgerMap as ELM")
        .join("Accounting.ChartOfAccounts as COA", (on) => on.on("COA.LedgerUID", "ELM.LedgerUID").andOnVal("COA.IsDeleted", "=", 0))
        .select("COA.CurrentBalance", "COA.CurrentBalanceType")
        .where({ "ELM.VendorUID": partyUID, "ELM.OrgUID": orgUID, "ELM.EntityType": "Vendor", "ELM.IsDeleted": 0 })
        .first();
      return { balance: Number(row?.CurrentBalance ?? 0), type: row?.CurrentBalanceType ?? "Credit" };
    }
    return null;
  }
}
