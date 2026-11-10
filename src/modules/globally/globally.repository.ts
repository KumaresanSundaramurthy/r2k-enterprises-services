import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

/**
 * Tables Global_model::getSingleRow may read through the API, with their readable columns. Every read is limited to
 * the caller's organisation, so each table here must have OrgUID. Add a table only with the columns a caller needs —
 * never a table holding passwords, tokens or other organisations' data.
 */
export const SINGLE_ROW_TABLES: Record<string, readonly string[]> = {
  "Products.BarcodeConfigTbl": [
    "ConfigUID", "OrgUID", "ConfigType", "Format", "BarWidth", "Height", "ShowValue", "FontSize", "LineColor",
    "Size", "ErrorLevel", "DarkColor", "LightColor", "IsEnabled", "IsActive", "IsDeleted", "CreatedBy", "UpdatedBy", "CreatedOn", "UpdatedOn",
  ],
  "Products.BarcodeLabelLayoutTbl": [
    "LayoutUID", "OrgUID", "LabelType", "LabelSizeKey", "LabelWidthPx", "LabelHeightPx", "FieldsLayout", "BarcodeConfig",
    "IsActive", "IsDeleted", "CreatedBy", "UpdatedBy", "CreatedOn", "UpdatedOn",
  ],
};

// Payments counted as received on a document: live, not cancelled, and not an expense / income record's own payment
const PAID_ON = (alias: string) =>
  `COALESCE((SELECT SUM(P.Amount) FROM Transaction.PaymentsTbl P WHERE P.TransUID = ${alias}.TransUID AND P.OrgUID = ${alias}.OrgUID
     AND P.IsDeleted = 0 AND P.IsActive = 1 AND P.IsCancelled = 0
     AND (P.SourceType IS NULL OR P.SourceType NOT IN ('Expense', 'IndirectIncome'))), 0)`;

/** Reads behind CI3's Globally controller: timezones, message templates and the records they are filled from. */
@Injectable()
export class GloballyRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // Global_model::getSingleRow — first matching row of an allowed table (table, columns and filters checked by the service)
  async singleRow(table: string, columns: readonly string[], where: Row): Promise<Row | null> {
    const row = await this.read(table).select(columns).where(where).limit(1).first();
    return (row as Row | undefined) ?? null;
  }

  // Global_model::getTaxDetailsInfo — active GST rates in display order
  taxDetails(): Promise<Row[]> {
    return this.read("Global.TaxDetailsTbl as TaxDetail")
      .select("TaxDetail.TaxDetailsUID", "TaxDetail.TaxName", "TaxDetail.Percentage", "TaxDetail.CGST", "TaxDetail.SGST", "TaxDetail.IGST", "TaxDetail.UpdatedOn")
      .where({ "TaxDetail.IsDeleted": 0, "TaxDetail.IsActive": 1 })
      .orderBy("TaxDetail.Sorting", "asc");
  }

  // Global_model::getStorageTypeData — active storage types in display order
  storageTypes(): Promise<Row[]> {
    return this.read("Global.StorageTypeTbl as StorageType")
      .select("StorageType.StorageTypeUID", "StorageType.Name", "StorageType.UpdatedOn")
      .where({ "StorageType.IsDeleted": 0, "StorageType.IsActive": 1 })
      .orderBy("StorageType.Sorting", "asc");
  }

  // Global_model::getTimezoneDetails
  timezones(): Promise<Row[]> {
    return this.read("Global.TimezoneTbl as Tzone").select(
      "Tzone.TimezoneUID",
      "Tzone.CountryCode",
      "Tzone.CountryName",
      "Tzone.Timezone",
      "Tzone.GmtOffset",
      "Tzone.UTCOffset",
      "Tzone.RawOffset"
    );
  }

  // Organisation_model::getMessageTemplate — the org's template for a module and channel
  async messageTemplate(orgUID: number, moduleUID: number, channel: string): Promise<Row | null> {
    const row = await this.read("Settings.MessageTemplatesTbl")
      .select("TemplateUID", "ModuleUID", "Channel", "Subject", "Body")
      .where({ OrgUID: orgUID, ModuleUID: moduleUID, Channel: channel, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? null;
  }

  // Transactions_model::getPaymentDetailById — the fields the payment template uses
  async payment(orgUID: number, paymentUID: number): Promise<Row | null> {
    const k = this.read;
    const row = await k("Transaction.PaymentsTbl as P")
      .select(
        "P.PaymentUID",
        "P.Amount",
        "P.IsFullyPaid",
        "P.PaymentDate",
        "P.CreatedOn",
        "P.UniqueNumber",
        "P.ReceiptToken",
        "PT.Name as PaymentTypeName",
        "T.UniqueNumber as TransNumber",
        "T.BalanceAmount",
        k.raw("CASE WHEN ?? = 'C' THEN ?? ELSE ?? END AS ??", ["P.PartyType", "C.Name", "V.Name", "PartyName"])
      )
      .leftJoin("Global.PaymentTypesTbl as PT", "PT.PaymentTypeUID", "P.PaymentTypeUID")
      // Expense / income payments keep their own record's UID in TransUID, so they have no linked document
      .leftJoin("Transaction.TransactionsTbl as T", (on) =>
        on
          .on("T.TransUID", "P.TransUID")
          .andOnVal("T.IsDeleted", "=", 0)
          .andOn(k.raw("(?? IS NULL OR ?? NOT IN ('Expense', 'IndirectIncome'))", ["P.SourceType", "P.SourceType"]))
      )
      .leftJoin("Customers.CustomerTbl as C", (on) => on.on("C.CustomerUID", "P.PartyUID").andOnVal("P.PartyType", "=", "C"))
      .leftJoin("Vendors.VendorTbl as V", (on) => on.on("V.VendorUID", "P.PartyUID").andOnVal("P.PartyType", "=", "S"))
      .where({ "P.PaymentUID": paymentUID, "P.OrgUID": orgUID })
      .first();
    return (row as Row | undefined) ?? null;
  }

  // Transactions_model::getTransactionById (module 103) — with what has been paid on it
  async invoice(orgUID: number, transUID: number): Promise<Row | null> {
    const k = this.read;
    const row = await k("Transaction.TransactionsTbl as Ts")
      .select(
        "Ts.TransUID",
        "Ts.UniqueNumber",
        "Ts.TransDate",
        "Ts.CreatedOn",
        "Ts.TransToken",
        "Ts.NetAmount",
        "Ts.SubTotal",
        "Ts.TaxAmount",
        "Ts.DiscountAmount",
        "Td.ValidityDate",
        k.raw("COALESCE(??, ??) AS ??", ["Cust.Name", "Vend.Name", "PartyName"]),
        k.raw(`${PAID_ON("Ts")} AS PaidAmount`)
      )
      .leftJoin("Transaction.TransDetailTbl as Td", (on) => on.on("Td.TransUID", "Ts.TransUID").andOn(k.raw("?? = YEAR(??)", ["Td.FinancialYear", "Ts.TransDate"])))
      .leftJoin("Customers.CustomerTbl as Cust", (on) => on.on("Cust.CustomerUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "C"))
      .leftJoin("Vendors.VendorTbl as Vend", (on) => on.on("Vend.VendorUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "=", "S"))
      .where({ "Ts.TransUID": transUID, "Ts.OrgUID": orgUID, "Ts.ModuleUID": 103, "Ts.IsDeleted": 0 })
      .first();
    return (row as Row | undefined) ?? null;
  }

  // GenSettings->CurrenySymbol and ListDateFormat (format_datedisplay)
  async displaySettings(orgUID: number): Promise<{ currency: string; dateFormat: string }> {
    const row = await this.read("Settings.OrgSettingsTbl").select("CurrenySymbol", "ListDateFormat").where({ OrgUID: orgUID }).first();
    return { currency: String(row?.CurrenySymbol || "₹"), dateFormat: String(row?.ListDateFormat || "d-m-Y") };
  }

  // Dbwrite_ext_model::decrementGstinPoints — one point used, never below zero
  async useGstinPoint(orgUID: number): Promise<void> {
    await this.db.write("Settings.OrgCreditSettingsTbl").where({ OrgUID: orgUID }).where("GstinPoints", ">", 0).update({ GstinPoints: this.db.write.raw("GstinPoints - 1"), UpdatedAt: this.db.write.fn.now() });
  }
}
