/** What differs between the document types that share the transaction engine (CI3 module controllers' $cfg). */
export interface DocumentKind {
  moduleUID: number;
  // TransactionsTbl.TransType
  transType: string;
  // Used in messages: "Quotation not found.", "Purchase bill ID is required."
  label: string;
  // C (customer) or S (supplier / vendor) — the party posted in partyPostKey
  partyType: "C" | "S";
  partyPostKey: "customerSearch" | "vendorSearch";
  // DocStatus of a saved (non-draft) document
  initialStatus: string;
  // Posted field holding DocType (quotationType / orderType / poType / purchaseType / invoiceType / …) and its default
  docTypePostKey: string;
  docTypeDefault?: string;
  // Posted field stored as TransDetailTbl.Reference (default referenceDetails; challans: vehicleNumber)
  referencePostKey?: string;
  // A finalised draft is always updated in place (CI3 pro formas and challans never re-insert it)
  noReinsert?: boolean;
  // Posted field stored as DispatchFrom; null: always NULL
  dispatchPostKey: string | null;
  // Posted fields stored as TransDetailTbl.ValidityDate / ValidityDays (validity, delivery, expected, due or return date); null: not stored
  validityDatePostKey: string | null;
  validityDaysPostKey?: string;
  // Posted field stored as TransDetailTbl.SupplierInvoiceNo (purchase bills)
  supplierInvoicePostKey?: string;
  // New rows start with PaidAmount 0, BalanceAmount = net, IsFullyPaid 0 (bills that take payments)
  tracksPayments: boolean;
  // Users.UserPreferencesTbl key of the list's saved date filter
  datePreference: string;
  // Tab slug in the page URL → list Status filter
  tabSlugMap: Record<string, string>;
  // The list page answers with the WhatsApp template / the summary stats (CI3 getPageDetails map)
  listWhatsApp: boolean;
  listStats: boolean;
  // Storage folder of attachments
  attachFolder: string;
  // Finalising a draft whose number is taken meanwhile: move to the next free number, or refuse
  onTakenNumber: "next" | "refuse";
  // Refusal when a draft is finalised without a prefix
  finaliseNoPrefix: string;
  audit: { entity: string; module: string; action: string; noun: string };
}

export const QUOTATION: DocumentKind = {
  moduleUID: 101,
  transType: "Quotation",
  label: "Quotation",
  partyType: "C",
  partyPostKey: "customerSearch",
  initialStatus: "Pending",
  docTypePostKey: "quotationType",
  dispatchPostKey: "dispatchFrom",
  validityDatePostKey: "validityDate",
  validityDaysPostKey: "validityDays",
  tracksPayments: false,
  datePreference: "df_quotations",
  tabSlugMap: { all: "All", open: "Open", accepted: "Accepted", converted: "Converted", cancelled: "Cancelled", draft: "Draft" },
  listWhatsApp: true,
  listStats: true,
  attachFolder: "quotations",
  onTakenNumber: "next",
  finaliseNoPrefix: "Please select a prefix to finalize this quotation.",
  audit: { entity: "Quotation", module: "Quotations", action: "QUOTATION", noun: "quotation" },
};

export const SALES_ORDER: DocumentKind = {
  moduleUID: 102,
  transType: "SalesOrder",
  label: "Sales Order",
  partyType: "C",
  partyPostKey: "customerSearch",
  initialStatus: "Pending",
  docTypePostKey: "orderType",
  dispatchPostKey: "dispatchFrom",
  validityDatePostKey: "deliveryDate",
  tracksPayments: false,
  datePreference: "df_salesorders",
  tabSlugMap: { all: "All", pending: "Pending", completed: "Completed", cancelled: "Cancelled", draft: "Draft" },
  listWhatsApp: true,
  listStats: true,
  attachFolder: "salesorders",
  onTakenNumber: "refuse",
  finaliseNoPrefix: "Please select a prefix to finalize this sales order.",
  audit: { entity: "SalesOrder", module: "SalesOrders", action: "SALES_ORDER", noun: "sales order" },
};

export const PURCHASE_ORDER: DocumentKind = {
  moduleUID: 104,
  transType: "PurchaseOrder",
  label: "Purchase order",
  partyType: "S",
  partyPostKey: "vendorSearch",
  initialStatus: "Received",
  docTypePostKey: "poType",
  dispatchPostKey: null,
  validityDatePostKey: "expectedDate",
  tracksPayments: false,
  datePreference: "df_purchaseorders",
  tabSlugMap: { all: "All", received: "Received", closed: "Closed", cancelled: "Cancelled", draft: "Draft" },
  listWhatsApp: false,
  listStats: false,
  attachFolder: "purchaseorders",
  onTakenNumber: "refuse",
  finaliseNoPrefix: "Please select a prefix to finalise this purchase order.",
  audit: { entity: "PurchaseOrder", module: "PurchaseOrders", action: "PURCHASE_ORDER", noun: "purchase order" },
};

export const PURCHASE: DocumentKind = {
  moduleUID: 105,
  transType: "Purchase",
  label: "Purchase bill",
  partyType: "S",
  partyPostKey: "vendorSearch",
  initialStatus: "Received",
  docTypePostKey: "purchaseType",
  dispatchPostKey: "dispatchTo",
  validityDatePostKey: "billDueDate",
  supplierInvoicePostKey: "supplierInvoiceNo",
  tracksPayments: true,
  datePreference: "df_purchases",
  tabSlugMap: { all: "All", pending: "Pending", paid: "Paid", cancelled: "Cancelled", draft: "Draft" },
  listWhatsApp: false,
  listStats: false,
  attachFolder: "purchases",
  onTakenNumber: "refuse",
  finaliseNoPrefix: "Please select a prefix to finalise this purchase bill.",
  audit: { entity: "Purchase", module: "Purchases", action: "PURCHASE", noun: "purchase bill" },
};

export const PURCHASE_RETURN: DocumentKind = {
  moduleUID: 108,
  transType: "Purchase Return",
  label: "Purchase Return",
  partyType: "S",
  partyPostKey: "vendorSearch",
  initialStatus: "Approved",
  docTypePostKey: "purchaseType",
  dispatchPostKey: "dispatchTo",
  validityDatePostKey: "returnDate",
  tracksPayments: false,
  datePreference: "df_purchasereturns",
  tabSlugMap: { all: "All", pending: "PRPending", settled: "Paid", cancelled: "Cancelled", drafts: "Draft" },
  listWhatsApp: false,
  listStats: false,
  attachFolder: "purchasereturns",
  onTakenNumber: "refuse",
  finaliseNoPrefix: "Please select a prefix to finalise this return.",
  audit: { entity: "PurchaseReturn", module: "PurchaseReturns", action: "PURCHASE_RETURN", noun: "purchase return" },
};

export const INVOICE: DocumentKind = {
  moduleUID: 103,
  transType: "Invoice",
  label: "Invoice",
  partyType: "C",
  partyPostKey: "customerSearch",
  initialStatus: "Issued",
  docTypePostKey: "invoiceType",
  dispatchPostKey: "dispatchFrom",
  validityDatePostKey: "dueDate",
  tracksPayments: true,
  datePreference: "df_invoices",
  tabSlugMap: { all: "All", pending: "InvPending", paid: "Paid", cancelled: "Cancelled", draft: "Draft", creditnotes: "CreditNotes" },
  listWhatsApp: true,
  listStats: true,
  attachFolder: "invoices",
  onTakenNumber: "refuse",
  finaliseNoPrefix: "Please select a prefix to finalise this invoice.",
  audit: { entity: "Invoice", module: "Invoices", action: "INVOICE", noun: "invoice" },
};

export const SALES_RETURN: DocumentKind = {
  moduleUID: 106,
  transType: "Sales Return",
  label: "Sales Return",
  partyType: "C",
  partyPostKey: "customerSearch",
  initialStatus: "Approved",
  docTypePostKey: "returnType",
  dispatchPostKey: "dispatchFrom",
  validityDatePostKey: "returnDate",
  tracksPayments: false,
  datePreference: "df_salesreturns",
  tabSlugMap: { all: "All", pending: "SRPending", paid: "Paid", cancelled: "Cancelled", drafts: "Draft" },
  listWhatsApp: false,
  listStats: true,
  attachFolder: "salesreturns",
  onTakenNumber: "refuse",
  finaliseNoPrefix: "Please select a prefix to finalise this return.",
  audit: { entity: "SalesReturn", module: "SalesReturns", action: "SALES_RETURN", noun: "sales return" },
};

export const DELIVERY_CHALLAN: DocumentKind = {
  moduleUID: 112,
  transType: "DeliveryChallan",
  label: "Delivery Challan",
  partyType: "C",
  partyPostKey: "customerSearch",
  initialStatus: "Dispatched",
  docTypePostKey: "challanType",
  docTypeDefault: "Non-Returnable",
  referencePostKey: "vehicleNumber",
  noReinsert: true,
  dispatchPostKey: "dispatchFrom",
  validityDatePostKey: null,
  tracksPayments: false,
  datePreference: "df_deliverychallans",
  tabSlugMap: { all: "All", dispatched: "Dispatched", delivered: "Delivered", converted: "Converted", cancelled: "Cancelled", draft: "Draft" },
  listWhatsApp: false,
  listStats: false,
  attachFolder: "deliverychallans",
  onTakenNumber: "refuse",
  finaliseNoPrefix: "Please select a prefix to finalize this challan.",
  audit: { entity: "DeliveryChallan", module: "DeliveryChallans", action: "DELIVERY_CHALLAN", noun: "delivery challan" },
};

export const PROFORMA_INVOICE: DocumentKind = {
  moduleUID: 113,
  transType: "ProFormaInvoice",
  label: "Pro Forma Invoice",
  partyType: "C",
  partyPostKey: "customerSearch",
  initialStatus: "Sent",
  docTypePostKey: "invoiceType",
  docTypeDefault: "Regular",
  noReinsert: true,
  dispatchPostKey: "dispatchFrom",
  validityDatePostKey: "validityDate",
  tracksPayments: false,
  datePreference: "df_proformainvoices",
  tabSlugMap: { all: "All", sent: "Sent", converted: "Converted", expired: "Expired", cancelled: "Cancelled", drafts: "Draft" },
  listWhatsApp: false,
  listStats: false,
  attachFolder: "proformainvoices",
  onTakenNumber: "refuse",
  finaliseNoPrefix: "Please select a prefix to send this Pro Forma.",
  audit: { entity: "ProformaInvoice", module: "ProformaInvoices", action: "PROFORMA", noun: "pro forma invoice" },
};

// Document types migrated so far; the shared endpoints (list, bulk delete) accept only these
export const DOCUMENT_KINDS: Record<number, DocumentKind> = Object.fromEntries(
  [QUOTATION, SALES_ORDER, INVOICE, PURCHASE_ORDER, PURCHASE, SALES_RETURN, PURCHASE_RETURN, DELIVERY_CHALLAN, PROFORMA_INVOICE].map((kind) => [kind.moduleUID, kind])
);

export function kindOf(moduleUID: number): DocumentKind | null {
  return DOCUMENT_KINDS[moduleUID] ?? null;
}
