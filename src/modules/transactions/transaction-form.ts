import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";

export type Form = Record<string, unknown>;

// One line of the posted Items JSON (the CI3 transaction forms' item objects)
export type ItemInput = Record<string, unknown>;

// Amounts and numbers taken from a transaction form (CI3 _extractTransAmounts)
export interface TransAmounts {
  prefixUID: number;
  transNumber: number;
  transDate: string;
  financialYear: number;
  isDraft: boolean;
  items: ItemInput[];
  totalQty: number;
  totalItems: number;
  subTotal: number;
  discountAmount: number;
  taxAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  additionalChargesTotal: number;
  roundOff: number;
  globalDiscPercent: number;
  extraDiscount: number;
  netAmount: number;
}

const GST_SLABS = [0, 5, 12, 18, 28];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isNumeric = (value: string) => value !== "" && !Number.isNaN(Number(value)) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value);

interface Rule {
  label: string;
  required?: boolean;
  numeric?: boolean;
  greaterThan?: number;
  atLeast?: number;
  atMost?: { limit: number; message: string };
  date?: boolean;
  maxLength?: number;
  oneOf?: string[];
}

// transactionValidateForm — rules apply only to the fields that were posted (as in CI3)
const HEADER_RULES: Record<string, Rule> = {
  customerSearch: { label: "Customer", required: true, numeric: true, greaterThan: 0 },
  transPrefixSelect: { label: "Prefix", required: true, numeric: true, greaterThan: 0 },
  transNumber: { label: "Transaction Number", required: true, numeric: true, greaterThan: 0 },
  transDate: { label: "Transaction Date", required: true, date: true },
  validityDate: { label: "Validity Date", date: true },
  globalDiscount: { label: "Global Discount", numeric: true, atLeast: 0, atMost: { limit: 100, message: "Global discount cannot exceed 100%." } },
  extraDiscount: { label: "Extra Discount", numeric: true, atLeast: 0 },
  NetAmount: { label: "Net Amount", numeric: true, atLeast: 0 },
  transNotes: { label: "Notes", maxLength: 500 },
  transTermsCond: { label: "Terms & Conditions", maxLength: 1000 },
  referenceDetails: { label: "Reference", maxLength: 100 },
  action: { label: "Action", oneOf: ["save", "draft"] },
};

function headerErrors(form: Form): string[] {
  const errors: string[] = [];
  for (const [field, rule] of Object.entries(HEADER_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(form, field)) continue;
    const value = String(form[field] ?? "").trim();
    if (value === "") {
      if (rule.required) errors.push(`The ${rule.label} field is required.`);
      continue;
    }
    if (rule.numeric && !isNumeric(value)) {
      errors.push(`The ${rule.label} field must contain only numbers.`);
      continue;
    }
    const number = Number(value);
    if (rule.greaterThan !== undefined && !(number > rule.greaterThan)) errors.push(`The ${rule.label} field must contain a number greater than ${rule.greaterThan}.`);
    else if (rule.atLeast !== undefined && !(number >= rule.atLeast)) errors.push(`The ${rule.label} field must contain a number greater than or equal to ${rule.atLeast}.`);
    else if (rule.atMost && number > rule.atMost.limit) errors.push(rule.atMost.message);
    else if (rule.date && !DATE.test(value)) errors.push(`The ${rule.label} field is not in the correct format.`);
    else if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`The ${rule.label} field cannot exceed ${rule.maxLength} characters in length.`);
    else if (rule.oneOf && !rule.oneOf.includes(value)) errors.push(`The ${rule.label} field must be one of: ${rule.oneOf.join(",")}.`);
  }
  return errors;
}

// validateQuotationItems — the first problem found, or ""
function itemsError(itemsJson: string): string {
  if (!itemsJson) return "Items are required.";
  let items: unknown;
  try {
    items = JSON.parse(itemsJson);
  } catch {
    items = null;
  }
  if (!Array.isArray(items) || items.length === 0) return "At least one line item is required.";

  for (const [index, raw] of items.entries()) {
    const item = (raw ?? {}) as ItemInput;
    const row = index + 1;
    if ((parseInt(String(item.id ?? 0), 10) || 0) <= 0) return `Row ${row}: Invalid product.`;
    if (!String(item.itemName ?? "").trim()) return `Row ${row}: Item name is required.`;
    const qty = Number(item.quantity);
    if (item.quantity === "" || item.quantity === null || item.quantity === undefined || Number.isNaN(qty) || qty <= 0) return `Row ${row}: Quantity must be greater than zero.`;
    const unitPrice = item.unitPrice;
    if (unitPrice === null || unitPrice === undefined || unitPrice === "" || Number.isNaN(Number(unitPrice)) || Number(unitPrice) < 0) {
      return `Row ${row}: Selling price must be zero or greater.`;
    }
    const taxPercent = item.taxPercent;
    if (taxPercent === null || taxPercent === undefined || taxPercent === "" || Number.isNaN(Number(taxPercent))) return `Row ${row}: Tax percentage is invalid.`;
    const taxPct = Number(taxPercent);
    if (taxPct < 0 || taxPct > 100) return `Row ${row}: Tax percentage must be between 0 and 100.`;
    if (!GST_SLABS.includes(taxPct)) return `Row ${row}: Tax percentage ${taxPct}% is not a valid GST slab.`;
    const cgst = Number(item.cgstPercent ?? 0) || 0;
    const sgst = Number(item.sgstPercent ?? 0) || 0;
    const igst = Number(item.igstPercent ?? 0) || 0;
    if (igst === 0 && Math.round((cgst + sgst) * 10000) !== Math.round(taxPct * 10000)) return `Row ${row}: CGST + SGST must equal total tax percentage.`;
    const discount = Number(item.discountAmount ?? 0) || 0;
    if (discount < 0) return `Row ${row}: Discount amount cannot be negative.`;
    const lineSubtotal = qty * Number(unitPrice);
    if (discount > lineSubtotal) return `Row ${row}: Discount cannot exceed line total (${lineSubtotal}).`;
    if ((Number(item.line_total ?? 0) || 0) < 0) return `Row ${row}: Line total cannot be negative.`;
    if (parseInt(String(item.IsBrandApplicable ?? 0), 10) === 1 && (parseInt(String(item.brandUID ?? 0), 10) || 0) <= 0 && (parseInt(String(item.variantUID ?? 0), 10) || 0) <= 0) {
      return `Row ${row}: Brand selection is required for '${item.itemName}'.`;
    }
  }
  return "";
}

/** _validateTransForm + _extractTransAmounts — throws the CI3 message on any problem. */
export function readTransactionForm(form: Form): TransAmounts {
  const errors = headerErrors(form);
  if (errors.length > 0) throw new CiValidationError(errors.join("\n"));
  const itemsJson = String(postValue(form, "Items") ?? "");
  const itemProblem = itemsError(itemsJson);
  if (itemProblem) throw new CiValidationError(itemProblem);

  const items = JSON.parse(itemsJson) as ItemInput[];
  const amount = (key: string) => Number(postValue(form, key, 0)) || 0;
  const transDate = postString(form, "transDate") ?? "";
  return {
    prefixUID: postInt(form, "transPrefixSelect"),
    transNumber: postInt(form, "transNumber"),
    transDate,
    financialYear: Number(transDate.slice(0, 4)),
    isDraft: postString(form, "action") === "draft",
    items,
    totalQty: items.reduce((total, item) => total + (Number(item.quantity) || 0), 0),
    totalItems: items.length,
    subTotal: amount("SubTotal"),
    discountAmount: amount("DiscountAmount"),
    taxAmount: amount("TaxAmount"),
    cgstAmount: amount("CgstAmount"),
    sgstAmount: amount("SgstAmount"),
    igstAmount: amount("IgstAmount"),
    additionalChargesTotal: amount("AdditionalChargesTotal"),
    roundOff: amount("RoundOff"),
    globalDiscPercent: amount("GlobalDiscPercent"),
    extraDiscount: amount("extraDiscount"),
    netAmount: amount("NetAmount"),
  };
}
