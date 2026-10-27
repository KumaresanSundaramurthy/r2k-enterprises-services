import { randomUUID } from "crypto";
import { WriteContext } from "../../core/request/write-context";
import { postFlag, postInt, postString, postValue } from "../../core/utils/form-values";
import { AddressInput, PartyTables } from "../../libraries/party-details/party-details.service";
import { CustomerFormDto } from "./dto/customer-form.dto";

export const CUSTOMER_TABLES: PartyTables = {
  schema: "Customers",
  entityColumn: "CustomerUID",
  bankTable: "CustBankDetailsTbl",
  bankPk: "CustBankDetUID",
  addressTable: "CustAddressTbl",
  addressPk: "CustAddressUID",
};

export type AddressPrefix = "Bill" | "Ship";

// Customers.CustomerTbl row from the form (CI3 Customers::buildCustomerFormData).
export function buildCustomerRow(form: CustomerFormDto, ctx: WriteContext, isCreate: boolean): Record<string, unknown> {
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
    DebitCreditType: postString(form, "DebitCreditCheck", "Debit"),
    DebitCreditAmount: postValue(form, "DebitCreditAmount", 0),
    PANNumber: postString(form, "PANNumber"),
    ContactPerson: postString(form, "ContactPerson"),
    DateOfBirth: postString(form, "CPDateOfBirth"),
    GSTIN: postString(form, "GSTIN"),
    CompanyName: postString(form, "CompanyName"),
    WorkPhone: postString(form, "WorkPhone"),
    LandlineNumber: postString(form, "LandlineNumber"),
    DiscountPercent: postValue(form, "DiscountPercent", 0),
    CreditPeriod: postValue(form, "CreditPeriod", 30),
    CreditLimit: postValue(form, "CreditLimit", 0),
    Notes: postString(form, "Notes"),
    Tags: postValue(form, "Tags", null, true),
    CCEmails: postValue(form, "CCEmails", null, true),
    AllowPortalAccess: postFlag(form, "AllowPortalAccess"),
    GSTINValidated: postFlag(form, "GSTINValidated"),
    CustomerTypeUID: postInt(form, "CustomerTypeUID"),
    SalutationUID: salutation || null,
    UpdatedBy: ctx.userUID,
  };
  if (isCreate) {
    row.CustToken = randomUUID();
    row.CreatedBy = ctx.userUID;
  }
  return row;
}

// {Bill|Ship}Addr* fields of the form as an address input for PartyDetailsService.
export function addressFromForm(form: CustomerFormDto, prefix: AddressPrefix): AddressInput {
  const value = (suffix: string) => postValue(form, `${prefix}${suffix}`) as string | null;
  const record = form as unknown as Record<string, unknown>;
  const uidKey = `${prefix}AddressUID`;
  return {
    addressUID: Object.prototype.hasOwnProperty.call(record, uidKey) ? (record[uidKey] as number | string) : null,
    line1: value("AddrLine1"),
    line2: value("AddrLine2"),
    pincode: (record[`${prefix}AddrPincode`] as string | undefined) ?? null,
    city: value("AddrCity"),
    cityText: value("AddrCityText"),
    state: value("AddrState"),
    stateText: value("AddrStateText"),
  };
}
