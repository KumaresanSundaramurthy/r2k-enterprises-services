import { randomUUID } from "crypto";
import { WriteContext } from "../../core/request/write-context";
import { postFlag, postInt, postString, postValue } from "../../core/utils/form-values";
import { CiFormValidator } from "../../core/validation/ci-form-validator";
import { validateDateYmd, validateGstin, validateMobileNumber, validatePan } from "../../core/validation/common-field-rules";
import { PartyTables } from "../../libraries/party-details/party-details.service";
import { VendorFormDto } from "./dto/vendor-form.dto";

export const VENDOR_TABLES: PartyTables = {
  schema: "Vendors",
  entityColumn: "VendorUID",
  bankTable: "VendBankDetailsTbl",
  bankPk: "VendBankDetUID",
  addressTable: "VendAddressTbl",
  addressPk: "VendAddressUID",
};

// Customer tables, for the customer created from the vendor form (CustomerLinkingCheck = NewCustomer)
export const LINKED_CUSTOMER_TABLES: PartyTables = {
  schema: "Customers",
  entityColumn: "CustomerUID",
  bankTable: "CustBankDetailsTbl",
  bankPk: "CustBankDetUID",
  addressTable: "CustAddressTbl",
  addressPk: "CustAddressUID",
};

// CI3 Formvalidation_model::vendorValidateForm — rules only apply to fields that are submitted.
export const vendorFormValidator = new CiFormValidator({
  VendorUID: { label: "Vendor UID", numeric: true },
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
  Notes: { label: "Notes", maxLength: 250 },
});

// Vendors.VendorTbl row from the form (CI3 Vendors::buildVendorFormData).
export function buildVendorRow(form: VendorFormDto, ctx: WriteContext, isCreate: boolean): Record<string, unknown> {
  const salutation = postInt(form, "SalutationUID");
  const row: Record<string, unknown> = {
    Name: postString(form, "Name"),
    Area: postString(form, "Area"),
    OrgUID: ctx.orgUID,
    BranchUID: ctx.branchUID,
    EmailAddress: postString(form, "EmailAddress"),
    CountryCode: postString(form, "CountryCode"),
    CountryISO2: postString(form, "CountryISO2", "IN"),
    MobileNumber: postString(form, "MobileNumber"),
    DebitCreditType: postString(form, "DebitCreditCheck", "Credit"),
    DebitCreditAmount: postValue(form, "DebitCreditAmount", 0),
    PANNumber: postString(form, "PANNumber"),
    ContactPerson: postString(form, "ContactPerson"),
    DateOfBirth: postString(form, "CPDateOfBirth"),
    GSTIN: postString(form, "GSTIN"),
    GSTINValidated: postFlag(form, "GSTINValidated"),
    CompanyName: postString(form, "CompanyName"),
    WorkPhone: postString(form, "WorkPhone"),
    LandlineNumber: postString(form, "LandlineNumber"),
    Notes: postString(form, "Notes"),
    SalutationUID: salutation || null,
    UpdatedBy: ctx.userUID,
  };
  if (isCreate) {
    row.VendToken = randomUUID();
    row.CreatedBy = ctx.userUID;
  }
  return row;
}

/**
 * Customers.CustomerTbl row for "also create as customer": CI3 inserts the vendor row as is, which fails
 * (CustomerTbl has CustToken, not VendToken); here the same values get a customer token instead.
 */
export function linkedCustomerRow(vendorRow: Record<string, unknown>): Record<string, unknown> {
  const { VendToken: _token, ...shared } = vendorRow;
  return { ...shared, CustToken: randomUUID() };
}
