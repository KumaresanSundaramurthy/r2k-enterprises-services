import { CiFormValidator } from "../../core/validation/ci-form-validator";
import {
  validateDateYmd,
  validateGstin,
  validateLandline,
  validateMobileNumber,
  validatePan,
  validateWorkPhone,
} from "../../core/validation/common-field-rules";

// CI3 Formvalidation_model::custValidateForm — rules only apply to fields that are submitted.
export const customerFormValidator = new CiFormValidator({
  CustomerUID: { label: "Customer UID", required: true, numeric: true },
  Name: { label: "Name", required: true, minLength: 3, maxLength: 100 },
  Area: { label: "Area", minLength: 3, maxLength: 100 },
  CountryCode: { label: "Country", required: true },
  CountryISO2: { label: "Country ISO2" },
  MobileNumber: { label: "Mobile Number", callbacks: [validateMobileNumber] },
  EmailAddress: { label: "Email Address", minLength: 6, maxLength: 100 },
  DebitCreditAmount: { label: "Debit Credit Amount", numeric: true },
  DebitCreditCheck: { label: "Debit Credit Check", required: true, inList: ["Debit", "Credit"] },
  PANNumber: { label: "PAN Number", callbacks: [validatePan] },
  ContactPerson: { label: "Contact Person", minLength: 3, maxLength: 100 },
  CPDateOfBirth: { label: "Date of Birth", regex: /^\d{4}-\d{2}-\d{2}$/, callbacks: [validateDateYmd] },
  GSTIN: { label: "GSTIN", maxLength: 15, callbacks: [validateGstin] },
  CompanyName: { label: "Company Name", minLength: 6, maxLength: 100 },
  WorkPhone: { label: "Work Phone", callbacks: [validateWorkPhone] },
  LandlineNumber: { label: "Landline Number", callbacks: [validateLandline] },
  DiscountPercent: { label: "Discount Percent", numeric: true, greaterThanOrEqual: 0, lessThanOrEqual: 100 },
  CreditPeriod: { label: "Credit Period", numeric: true },
  CreditLimit: { label: "Credit Limit", numeric: true },
  Notes: { label: "Notes", maxLength: 250 },
  Tags: { label: "Tags" },
  CCEmails: { label: "CCEmails" },
});
