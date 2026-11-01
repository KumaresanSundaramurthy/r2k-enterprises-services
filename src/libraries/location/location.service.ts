import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service";

/** Countries, states and cities for address forms (CI3 Location_model / Global_model location calls). */
@Injectable()
export class LocationService {
  constructor(private readonly db: DatabaseService) {}

  // getCountriesFromDB
  async countries(): Promise<Record<string, unknown>[]> {
    return this.db.read("Global.CountriesTbl").select("id", "name", "iso2", "phonecode", "emoji").where({ flag: 1 }).orderBy("name", "asc");
  }

  // getStatesFromDB — states of a country (ISO2)
  async states(countryISO2: string): Promise<Record<string, unknown>[]> {
    return this.db
      .read("Global.StatesTbl")
      .select("id", "name", "iso2")
      .where({ country_code: countryISO2.trim().toUpperCase(), flag: 1 })
      .orderBy("name", "asc");
  }

  // getAllCitiesOfCountryFromDB — every city of a country (ISO2)
  async cities(countryISO2: string): Promise<Record<string, unknown>[]> {
    return this.db
      .read("Global.CitiesTbl")
      .select("id", "name", "state_code")
      .where({ country_code: countryISO2.trim().toUpperCase(), flag: 1 })
      .orderBy("name", "asc");
  }

  // The organisation's country (CI3 JwtData->Org->OrgCISO2)
  async orgCountryISO2(orgUID: number): Promise<string> {
    const row = await this.db.read("Organisation.OrganisationTbl").select("CountryISO2").where({ OrgUID: orgUID }).first();
    return row?.CountryISO2 ?? "";
  }
}
