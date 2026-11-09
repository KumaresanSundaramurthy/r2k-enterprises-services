// CI3 TransactionExporter: column headers and the columns of each module × format. To change what a format
// exports, edit EXPORT_CONFIGS only.

export const EXPORT_FORMATS = ["csv", "excel", "pdf", "print"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ModuleExportConfig {
  title: string;
  formats: Record<ExportFormat, string[]>;
}

// Human-readable column headers
export const EXPORT_LABELS: Record<string, string> = {
  // Transaction columns
  UniqueNumber: "#",
  TransDate: "Date",
  PartyName: "Party Name",
  PartyArea: "Area / City",
  SubTotal: "Sub Total",
  DiscountAmount: "Discount",
  CgstAmount: "CGST",
  SgstAmount: "SGST",
  IgstAmount: "IGST",
  TaxAmount: "Total Tax",
  RoundOff: "Round Off",
  NetAmount: "Net Amount",
  PaidAmount: "Paid Amount",
  BalanceAmount: "Balance",
  Status: "Status",
  PaymentModes: "Payment Mode",
  ValidityDate: "Valid Until",
  Reference: "Reference",
  SupplierInvoiceNo: "Supplier Invoice #",
  PlaceOfSupply: "Place of Supply",
  CreatedBy: "Created By",
  // Shared columns
  MobileNumber: "Mobile",
  EmailAddress: "Email",
  UpdatedBy: "Updated By",
  UpdatedOn: "Last Updated",
  // Customer / Vendor columns
  CustName: "Customer Name",
  VendName: "Vendor Name",
  Area: "Area",
  GSTIN: "GSTIN",
  CompanyName: "Company",
  CustomerTypeName: "Customer Type",
  ClosingBalance: "Balance",
  ClosingBalanceType: "Balance Type",
  IsActiveLabel: "Status",
  // Activity Log columns
  CreatedOn: "Date / Time",
  UserName: "User",
  Module: "Module",
  AuditCategory: "Category",
  Action: "Action",
  EntityRef: "Reference",
  Result: "Result",
  Source: "Type",
  IPAddress: "IP Address",
  DeviceType: "Device",
  Summary: "Summary",
  // Customer Group columns
  GroupName: "Group Name",
  GroupCode: "Code",
  GroupType: "Group Type",
  MemberCount: "Members",
  ContactPerson: "Contact Person",
  Mobile: "Mobile",
  Email: "Email",
  TotalReceivable: "Receivable",
  TotalPayable: "Payable",
  // Product columns
  ItemName: "Item Name",
  CategoryName: "Category",
  HSNSACCode: "HSN/SAC",
  PartNumber: "Part No.",
  SellingPrice: "Selling Price",
  TaxPercentage: "Tax %",
  PurchasePrice: "Purchase Price",
  AvailableQuantity: "Stock",
};

// Money columns: right-aligned, written as numbers in Excel
export const MONEY_COLUMNS = new Set([
  "SubTotal",
  "DiscountAmount",
  "CgstAmount",
  "SgstAmount",
  "IgstAmount",
  "TaxAmount",
  "RoundOff",
  "NetAmount",
  "PaidAmount",
  "BalanceAmount",
  "ClosingBalance",
  "SellingPrice",
  "PurchasePrice",
  "TotalReceivable",
  "TotalPayable",
]);

// Date columns, shown in the org's list date format
export const DATE_COLUMNS = new Set(["TransDate", "ValidityDate", "UpdatedOn"]);

// Quotations / sales orders / purchase orders / pro formas share their columns; so do purchases and invoices in part
const ORDER_COLUMNS = (pdfValidity: boolean, printValidity: boolean): Record<ExportFormat, string[]> => ({
  csv: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "SubTotal", "TaxAmount", "NetAmount", "Status", "ValidityDate"],
  excel: [
    "UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "EmailAddress", "SubTotal", "DiscountAmount",
    "CgstAmount", "SgstAmount", "IgstAmount", "TaxAmount", "NetAmount", "Status", "ValidityDate", "Reference",
  ],
  pdf: ["UniqueNumber", "TransDate", "PartyName", "SubTotal", "TaxAmount", "NetAmount", "Status", ...(pdfValidity ? ["ValidityDate"] : [])],
  print: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "SubTotal", "DiscountAmount", "TaxAmount", "NetAmount", "Status", ...(printValidity ? ["ValidityDate"] : [])],
});

const RETURN_COLUMNS: Record<ExportFormat, string[]> = {
  csv: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "SubTotal", "TaxAmount", "NetAmount", "Status"],
  excel: [
    "UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "EmailAddress", "SubTotal", "DiscountAmount",
    "CgstAmount", "SgstAmount", "IgstAmount", "TaxAmount", "NetAmount", "Status", "Reference",
  ],
  pdf: ["UniqueNumber", "TransDate", "PartyName", "SubTotal", "TaxAmount", "NetAmount", "Status"],
  print: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "SubTotal", "DiscountAmount", "TaxAmount", "NetAmount", "Status"],
};

export const EXPORT_CONFIGS: Record<number, ModuleExportConfig> = {
  101: { title: "Quotations", formats: ORDER_COLUMNS(true, true) },
  102: { title: "Sales Orders", formats: ORDER_COLUMNS(false, false) },
  103: {
    title: "Invoices",
    formats: {
      csv: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "SubTotal", "TaxAmount", "NetAmount", "PaidAmount", "BalanceAmount", "Status", "PaymentModes"],
      excel: [
        "UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "EmailAddress", "SubTotal", "DiscountAmount", "CgstAmount",
        "SgstAmount", "IgstAmount", "TaxAmount", "RoundOff", "NetAmount", "PaidAmount", "BalanceAmount", "Status", "PaymentModes", "Reference",
      ],
      pdf: ["UniqueNumber", "TransDate", "PartyName", "SubTotal", "TaxAmount", "NetAmount", "PaidAmount", "BalanceAmount", "Status"],
      print: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "SubTotal", "DiscountAmount", "TaxAmount", "NetAmount", "PaidAmount", "BalanceAmount", "Status", "PaymentModes"],
    },
  },
  104: { title: "Purchase Orders", formats: ORDER_COLUMNS(false, false) },
  105: {
    title: "Purchases",
    formats: {
      csv: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "SubTotal", "TaxAmount", "NetAmount", "PaidAmount", "BalanceAmount", "Status", "SupplierInvoiceNo"],
      excel: [
        "UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "EmailAddress", "SubTotal", "DiscountAmount", "CgstAmount",
        "SgstAmount", "IgstAmount", "TaxAmount", "RoundOff", "NetAmount", "PaidAmount", "BalanceAmount", "Status", "SupplierInvoiceNo", "Reference",
      ],
      pdf: ["UniqueNumber", "TransDate", "PartyName", "SubTotal", "TaxAmount", "NetAmount", "PaidAmount", "BalanceAmount", "Status"],
      print: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "SubTotal", "DiscountAmount", "TaxAmount", "NetAmount", "PaidAmount", "BalanceAmount", "Status", "SupplierInvoiceNo"],
    },
  },
  106: { title: "Sales Returns", formats: RETURN_COLUMNS },
  108: { title: "Purchase Returns", formats: RETURN_COLUMNS },
  112: {
    title: "Delivery Challans",
    formats: {
      csv: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "NetAmount", "Status"],
      excel: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "MobileNumber", "EmailAddress", "SubTotal", "TaxAmount", "NetAmount", "Status", "Reference"],
      pdf: ["UniqueNumber", "TransDate", "PartyName", "SubTotal", "TaxAmount", "NetAmount", "Status"],
      print: ["UniqueNumber", "TransDate", "PartyName", "PartyArea", "SubTotal", "TaxAmount", "NetAmount", "Status"],
    },
  },
  113: { title: "Proforma Invoices", formats: ORDER_COLUMNS(true, true) },
  201: {
    title: "Customers",
    formats: {
      csv: ["CustName", "Area", "MobileNumber", "EmailAddress", "GSTIN", "CustomerTypeName", "ClosingBalance", "ClosingBalanceType", "IsActiveLabel", "UpdatedOn", "UpdatedBy"],
      excel: ["CustName", "Area", "MobileNumber", "EmailAddress", "GSTIN", "CompanyName", "CustomerTypeName", "ClosingBalance", "ClosingBalanceType", "IsActiveLabel", "UpdatedOn", "UpdatedBy"],
      pdf: ["CustName", "Area", "MobileNumber", "GSTIN", "ClosingBalance", "ClosingBalanceType", "IsActiveLabel"],
      print: ["CustName", "Area", "MobileNumber", "EmailAddress", "GSTIN", "CustomerTypeName", "ClosingBalance", "ClosingBalanceType", "IsActiveLabel", "UpdatedBy"],
    },
  },
  202: {
    title: "Vendors",
    formats: {
      csv: ["VendName", "Area", "MobileNumber", "EmailAddress", "GSTIN", "ClosingBalance", "ClosingBalanceType", "IsActiveLabel", "UpdatedOn", "UpdatedBy"],
      excel: ["VendName", "Area", "MobileNumber", "EmailAddress", "GSTIN", "CompanyName", "ClosingBalance", "ClosingBalanceType", "IsActiveLabel", "UpdatedOn", "UpdatedBy"],
      pdf: ["VendName", "Area", "MobileNumber", "GSTIN", "ClosingBalance", "ClosingBalanceType", "IsActiveLabel"],
      print: ["VendName", "Area", "MobileNumber", "EmailAddress", "GSTIN", "ClosingBalance", "ClosingBalanceType", "IsActiveLabel", "UpdatedBy"],
    },
  },
  203: {
    title: "Products",
    formats: {
      csv: ["ItemName", "CategoryName", "HSNSACCode", "PartNumber", "SellingPrice", "TaxPercentage", "PurchasePrice", "AvailableQuantity", "IsActiveLabel", "UpdatedOn", "UpdatedBy"],
      excel: ["ItemName", "CategoryName", "HSNSACCode", "PartNumber", "SellingPrice", "TaxPercentage", "PurchasePrice", "AvailableQuantity", "IsActiveLabel", "UpdatedOn", "UpdatedBy"],
      pdf: ["ItemName", "CategoryName", "SellingPrice", "TaxPercentage", "PurchasePrice", "AvailableQuantity", "IsActiveLabel"],
      print: ["ItemName", "CategoryName", "HSNSACCode", "SellingPrice", "TaxPercentage", "PurchasePrice", "AvailableQuantity", "IsActiveLabel", "UpdatedBy"],
    },
  },
  204: {
    title: "Customer Groups",
    formats: {
      csv: ["GroupName", "GroupCode", "GroupType", "MemberCount", "ContactPerson", "Mobile", "Email", "TotalReceivable", "TotalPayable", "IsActiveLabel"],
      excel: ["GroupName", "GroupCode", "GroupType", "MemberCount", "ContactPerson", "Mobile", "Email", "TotalReceivable", "TotalPayable", "IsActiveLabel"],
      pdf: ["GroupName", "GroupCode", "GroupType", "MemberCount", "TotalReceivable", "TotalPayable", "IsActiveLabel"],
      print: ["GroupName", "GroupCode", "GroupType", "MemberCount", "ContactPerson", "Mobile", "TotalReceivable", "TotalPayable", "IsActiveLabel"],
    },
  },
  700: {
    title: "Activity Log",
    formats: {
      csv: ["CreatedOn", "UserName", "Module", "AuditCategory", "Action", "EntityRef", "Result", "Source", "IPAddress", "DeviceType", "Summary"],
      excel: ["CreatedOn", "UserName", "Module", "AuditCategory", "Action", "EntityRef", "Result", "Source", "IPAddress", "DeviceType", "Summary"],
      pdf: ["CreatedOn", "UserName", "Module", "Action", "EntityRef", "Result", "Summary"],
      print: ["CreatedOn", "UserName", "Module", "Action", "EntityRef", "Result", "Summary"],
    },
  },
};
