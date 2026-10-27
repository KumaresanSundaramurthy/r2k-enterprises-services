import { FieldCallback } from "./ci-form-validator";

/**
 * Validation callbacks shared by party forms (customers, vendors) — CI3 Formvalidation_model.
 * Phone checks use the CountryCode submitted with the same form.
 */

const countryCodeOf = (data: Record<string, unknown>): string =>
  data.CountryCode !== undefined ? String(data.CountryCode).replace("+", "") : "91";

const PHONE_PATTERNS: Record<string, RegExp> = {
  "91": /^[6-9]\d{9}$/,
  "1": /^\d{10}$/,
  "44": /^\d{10,11}$/,
  "61": /^\d{9}$/,
  "971": /^\d{9}$/,
};

function phoneValidator(messages: Record<string, string>, fallback: string): FieldCallback {
  return (value, data) => {
    const countryCode = countryCodeOf(data);
    const digits = value.replace(/[^0-9]/g, "").replace(/^0+/, "");
    const pattern = PHONE_PATTERNS[countryCode] ?? /^\d{5,15}$/;
    return pattern.test(digits) ? null : messages[countryCode] ?? fallback;
  };
}

export const validateMobileNumber = phoneValidator(
  {
    "91": "Invalid Indian mobile number. Must be 10 digits starting with 6–9.",
    "1": "Invalid US/Canada mobile number.",
    "44": "Invalid UK mobile number.",
    "61": "Invalid Australian mobile number.",
    "971": "Invalid UAE mobile number.",
  },
  "Invalid mobile number."
);

export const validateWorkPhone = phoneValidator(
  {
    "91": "Invalid Work Phone for India. Must be 10 digits starting with 6–9.",
    "1": "Invalid Work Phone for US/Canada.",
    "44": "Invalid Work Phone for UK.",
    "61": "Invalid Work Phone for Australia.",
    "971": "Invalid Work Phone for UAE.",
  },
  "Invalid Work Phone number."
);

export const validateLandline: FieldCallback = (value) =>
  /^\d{1,15}$/.test(value) ? null : "Landline number must contain digits only (max 15).";

export const validatePan: FieldCallback = (value) =>
  /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(value.toUpperCase()) ? null : "Invalid PAN format (ABCDE1234F).";

export const validateGstin: FieldCallback = (value) => {
  const gstin = value.toUpperCase();
  return gstin.length === 15 && /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)
    ? null
    : "Invalid GSTIN format (15 characters).";
};

// Must be a real calendar date in YYYY-MM-DD
export const validateDateYmd: FieldCallback = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.toISOString().slice(0, 10) === value) return null;
  }
  return "The {field} must be in YYYY-MM-DD format.";
};
