import { Injectable } from "@nestjs/common";
import { toInt } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

// Columns of an organisation address, as CI3 Organisation_model reads them
const ADDRESS_COLUMNS = ["OrgAddressUID", "Line1", "Line2", "Pincode", "City", "CityText", "State", "StateText"];

// CI3 Organisation_model queries used by the Settings → Organisation page.
@Injectable()
export class OrganisationRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getAllOrganisationAddressDetails — the organisation, its lookup names, timezone and billing address (B* columns)
  async findWithBilling(orgUID: number): Promise<Row | null> {
    const row = await this.read("Organisation.OrganisationTbl as Org")
      .select(
        "Org.OrgUID as OrgUID",
        "Org.Name as Name",
        "Org.ShortDescription as ShortDescription",
        "Org.BrandName as BrandName",
        "Org.ShortCode as ShortCode",
        "Org.Logo as Logo",
        "Org.CountryCode as CountryCode",
        "Org.CountryISO2 as CountryISO2",
        "Org.MobileNumber as MobileNumber",
        "Org.EmailAddress as EmailAddress",
        "Org.GSTIN as GSTIN",
        "Org.GSTINValidation as GSTINValidation",
        "Org.OrgBussTypeUID as OrgBussTypeUID",
        "Org.OrgIndTypeUID as OrgIndTypeUID",
        "Org.OrgBusRegTypeUID as OrgBusRegTypeUID",
        "Org.AlternateNumber as AlternateNumber",
        "Org.Website as Website",
        "Org.PANNumber as PANNumber",
        "Org.TimezoneUID as TimezoneUID",
        "Org.StateCode as StateCode",
        "Org.StateName as StateName",
        "Tz.Timezone as TimezoneText",
        "Tz.GmtOffset as TimezoneGmtOffset",
        "BusinessType.Name as OrgBusinessTypeName",
        "IndType.Name as OrgIndTypeName",
        "BusRegType.Name as OrgBusRegTypeName",
        "Billing.OrgAddressUID as BAddressUID",
        "Billing.Line1 as BLine1",
        "Billing.Line2 as BLine2",
        "Billing.Pincode as BPincode",
        "Billing.City as BCity",
        "Billing.CityText as BCityText",
        "Billing.State as BState",
        "Billing.StateText as BStateText"
      )
      .leftJoin("Organisation.OrgBusinessTypeTbl as BusinessType", "BusinessType.OrgBussTypeUID", "Org.OrgBussTypeUID")
      .leftJoin("Organisation.OrgIndustryTypeTbl as IndType", "IndType.OrgIndTypeUID", "Org.OrgIndTypeUID")
      .leftJoin("Organisation.OrgBusinessRegTypeTbl as BusRegType", "BusRegType.OrgBusRegTypeUID", "Org.OrgBusRegTypeUID")
      .leftJoin("Global.TimezoneTbl as Tz", "Tz.TimezoneUID", "Org.TimezoneUID")
      .leftJoin("Organisation.OrgAddressTbl as Billing", (on) => {
        on.on("Billing.OrgUID", "Org.OrgUID")
          .andOnVal("Billing.AddressType", "=", "Billing")
          .andOnVal("Billing.IsDeleted", "=", 0)
          .andOnVal("Billing.IsActive", "=", 1);
      })
      .where({ "Org.OrgUID": orgUID, "Org.IsActive": 1, "Org.IsDeleted": 0 })
      .first();
    return row ?? null;
  }

  // getOrgShippingAddresses — active shipping addresses, oldest first
  async shippingAddresses(orgUID: number): Promise<Row[]> {
    return this.read("Organisation.OrgAddressTbl")
      .select(ADDRESS_COLUMNS)
      .where({ OrgUID: orgUID, AddressType: "Shipping", IsActive: 1, IsDeleted: 0 })
      .orderBy("OrgAddressUID", "asc");
  }

  // GenSettings->MaxShippingAddr (default 3)
  async maxShippingAddresses(orgUID: number): Promise<number> {
    const row = await this.read("Settings.OrgSettingsTbl").select("MaxShippingAddr").where({ OrgUID: orgUID }).first();
    return row?.MaxShippingAddr == null ? 3 : toInt(row.MaxShippingAddr);
  }

  // getOrgBusinessTypeDetails / getOrgIndustryTypeDetails / getOrgBusRegTypeDetails — active rows of a global list
  async lookup(table: "OrgBusinessTypeTbl" | "OrgIndustryTypeTbl" | "OrgBusinessRegTypeTbl", idColumn: string): Promise<Row[]> {
    return this.read(`Organisation.${table}`).select(idColumn, "Name").where({ IsActive: 1, IsDeleted: 0 });
  }

  // JwtData->Org->Name
  async orgName(orgUID: number): Promise<string> {
    const row = await this.read("Organisation.OrganisationTbl").select("Name").where({ OrgUID: orgUID }).first();
    return row?.Name ?? "";
  }

  async orgToken(orgUID: number): Promise<string> {
    const row = await this.read("Organisation.OrganisationTbl").select("OrgToken").where({ OrgUID: orgUID }).first();
    return String(row?.OrgToken ?? "");
  }

  // getAllOrgDispatchAddresses — shipping addresses with org name, for transaction dispatch dropdowns
  async dispatchAddresses(orgUID: number): Promise<Row[]> {
    return this.read("Organisation.OrgAddressTbl as a")
      .select("a.OrgAddressUID", "a.OrgUID", "a.AddressType", "a.Line1", "a.Line2", "a.Pincode", "a.City", "a.CityText", "a.State", "a.StateText", "o.Name as OrgName")
      .leftJoin("Organisation.OrganisationTbl as o", "o.OrgUID", "a.OrgUID")
      .where({ "a.OrgUID": orgUID, "a.AddressType": "Shipping", "a.IsActive": 1, "a.IsDeleted": 0 })
      .orderBy("a.OrgAddressUID", "asc");
  }

  async updateOrganisation(orgUID: number, data: Row): Promise<void> {
    await this.db.write("Organisation.OrganisationTbl").where({ OrgUID: orgUID }).update(data);
  }

  async insertAddress(data: Row): Promise<number> {
    const [id] = await this.db.write("Organisation.OrgAddressTbl").insert(data);
    return Number(id);
  }

  // Address rows are always matched within the organisation
  async updateAddress(orgUID: number, addressUID: number, data: Row): Promise<number> {
    return this.db.write("Organisation.OrgAddressTbl").where({ OrgAddressUID: addressUID, OrgUID: orgUID }).update(data);
  }
}
