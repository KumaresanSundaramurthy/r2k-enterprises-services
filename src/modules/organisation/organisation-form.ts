import { postString } from "../../core/utils/form-values";
import { CiFormValidator } from "../../core/validation/ci-form-validator";
import { validateGstin, validateMobileNumber, validatePan } from "../../core/validation/common-field-rules";
import { Row } from "./organisation.repository";
import { OrganisationFormDto } from "./dto/organisation.dto";

// CI3 Formvalidation_model::orgValidateForm — rules only apply to fields that are submitted.
export const orgFormValidator = new CiFormValidator({
  OrgUID: { label: "Organisation UID", required: true, numeric: true },
  Name: { label: "Company Name", required: true, minLength: 6, maxLength: 100 },
  BrandName: { label: "Brand Name", required: true, minLength: 6, maxLength: 100 },
  ShortCode: {
    label: "Short Code",
    required: true,
    minLength: 3,
    maxLength: 3,
    callbacks: [(value) => (/^[a-zA-Z0-9]+$/.test(value) ? null : "The {field} field may only contain alpha-numeric characters.")],
  },
  Description: { label: "Description", maxLength: 100 },
  CountryCode: { label: "Country", required: true },
  CountryISO2: { label: "Country ISO2", required: true },
  MobileNumber: { label: "Mobile Number", callbacks: [validateMobileNumber] },
  EmailAddress: { label: "Email Address", required: true, minLength: 6, maxLength: 100 },
  GSTIN: { label: "GSTIN", maxLength: 15, callbacks: [validateGstin] },
  OrgBussTypeUID: { label: "Business Type", required: true, numeric: true },
  AlternateNumber: { label: "Alternate Number" },
  TimezoneUID: { label: "Timezone", numeric: true },
  PANNumber: { label: "PAN Number", callbacks: [validatePan] },
  Website: { label: "Website", maxLength: 255 },
});

// Organisation.OrganisationTbl values from the form (CI3 Organisation::updateOrgForm)
export function buildOrganisationRow(form: OrganisationFormDto, userUID: number): Row {
  return {
    Name: postString(form, "Name"),
    ShortDescription: postString(form, "Description"),
    BrandName: postString(form, "BrandName"),
    ShortCode: (postString(form, "ShortCode") ?? "").toUpperCase(),
    CountryCode: "+91",
    CountryISO2: "IN",
    MobileNumber: postString(form, "MobileNumber"),
    GSTIN: postString(form, "GSTIN"),
    OrgBussTypeUID: postString(form, "OrgBussTypeUID"),
    OrgIndTypeUID: postString(form, "OrgIndusTypeUID"),
    OrgBusRegTypeUID: postString(form, "OrgBusRegTypeUID"),
    AlternateNumber: postString(form, "AlternateNumber"),
    Website: postString(form, "Website"),
    PANNumber: postString(form, "PANNumber"),
    TimezoneUID: postString(form, "TimezoneUID"),
    StateCode: postString(form, "StateCode"),
    StateName: postString(form, "StateName"),
    UpdatedBy: userUID,
  };
}

// Billing address values (CI3 Organisation::handleAddress, BillAddr* fields)
export function buildBillingAddress(form: OrganisationFormDto, orgUID: number, userUID: number): Row {
  return {
    OrgUID: orgUID,
    Line1: postString(form, "BillAddrLine1"),
    Line2: postString(form, "BillAddrLine2"),
    Pincode: postString(form, "BillAddrPincode"),
    City: postString(form, "BillAddrCity"),
    CityText: postString(form, "BillAddrCityText"),
    State: postString(form, "BillAddrState"),
    StateText: postString(form, "BillAddrStateText"),
    UpdatedBy: userUID,
  };
}

// Shipping address as the CI3 page keeps it in memory (updateOrgForm's ShipAddresses response)
export function shipAddressForPage(address: Row): Row {
  return {
    UID: Number(address.OrgAddressUID),
    Line1: address.Line1 ?? "",
    Line2: address.Line2 ?? "",
    Pincode: address.Pincode ?? "",
    StateId: address.State ?? "",
    StateName: address.StateText ?? "",
    StateISO2: "",
    CityId: address.City ?? "",
    CityName: address.CityText ?? "",
  };
}
