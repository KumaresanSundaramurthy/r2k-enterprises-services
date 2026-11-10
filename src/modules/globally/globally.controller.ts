import { Controller, Get, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { GloballyService } from "./globally.service";

export class CountryCodeQueryDto {
  @ApiProperty({ example: "IN", description: "Country ISO2" }) @Allow() CountryCode?: string;
}

export class StateCitiesQueryDto {
  @ApiProperty({ example: "IN" }) @Allow() CountryISO2?: string;
  @ApiProperty({ example: "TN" }) @Allow() StateISO2?: string;
}

export class GstinQueryDto extends OrgContextDto {
  @ApiProperty({ example: "33AAAAA0000A1Z5" }) @Allow() gstin?: string;
}

export class IfscQueryDto {
  @ApiProperty({ example: "SBIN0000001" }) @Allow() ifsc?: string;
}

export class CommTemplateQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number, description: "103 Invoice, 110 Payment (others: template text without record tokens)" }) @Allow() ModuleUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "The invoice / payment whose details fill the tokens" }) @Allow() RecordUID?: string | number;
  @ApiPropertyOptional({ default: "Email", description: "Email / WhatsApp / SMS" }) @Allow() Channel?: string;
}

/** Shared lookups of CI3 (Globally controller): locations, timezones, GSTIN / IFSC lookups and message templates. */
@ApiTags("Globally")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/globally")
export class GloballyController {
  constructor(private readonly globally: GloballyService) {}

  @Get("getCountryInfo")
  @ApiOperation({ summary: "Countries (Data: id, name, iso2, phonecode, emoji)" })
  async getCountryInfo() {
    return ciSuccess(await this.globally.getCountryInfo());
  }

  @Get("getStateCityOfCountry")
  @ApiOperation({ summary: "States of a country (StateInfo: id, name, iso2)" })
  async getStateCityOfCountry(@Query() dto: CountryCodeQueryDto) {
    return ciSuccess(await this.globally.getStateCityOfCountry(String(dto.CountryCode ?? "")));
  }

  @Get("getStateofCountry")
  @ApiOperation({ summary: "States of a country (Data: id, name, iso2)" })
  async getStateofCountry(@Query() dto: CountryCodeQueryDto) {
    return ciSuccess(await this.globally.getStateofCountry(String(dto.CountryCode ?? "")));
  }

  @Get("getCitiesOfState")
  @ApiOperation({ summary: "Cities of a state (Data: id, name)" })
  async getCitiesOfState(@Query() dto: StateCitiesQueryDto) {
    return ciSuccess(await this.globally.getCitiesOfState(String(dto.CountryISO2 ?? ""), String(dto.StateISO2 ?? "")));
  }

  @Get("getTimezones")
  @ApiOperation({ summary: "Timezones (Data: TimezoneUID, CountryCode, CountryName, Timezone, GmtOffset, UTCOffset, RawOffset)" })
  async getTimezones() {
    return ciSuccess(await this.globally.getTimezones());
  }

  @Get("getCityofCountry")
  @ApiOperation({ summary: "Every city of a country (Data: id, name, state_code)" })
  async getCityofCountry(@Query() dto: CountryCodeQueryDto) {
    return ciSuccess(await this.globally.getCityofCountry(String(dto.CountryCode ?? "")));
  }

  @Get("getTaxDetailsInfo")
  @ApiOperation({ summary: "GST rates (Data: TaxDetailsUID, TaxName, Percentage, CGST, SGST, IGST, UpdatedOn)" })
  async getTaxDetailsInfo() {
    return ciSuccess(await this.globally.getTaxDetailsInfo());
  }

  @Get("getStorageTypeData")
  @ApiOperation({ summary: "Storage types (Data: StorageTypeUID, Name, UpdatedOn)" })
  async getStorageTypeData() {
    return ciSuccess(await this.globally.getStorageTypeData());
  }

  @Get("fetchGstinDetails")
  @ApiOperation({
    summary: "GSTIN lookup: legal / trade name, PAN, state, address; uses one GSTIN credit point (GstinPoints). NoCreditPoints: true when none are left",
  })
  async fetchGstinDetails(@Query() dto: GstinQueryDto) {
    return ciSuccess(await this.globally.fetchGstinDetails(dto.orgId, String(dto.gstin ?? "")));
  }

  @Get("fetchIfscDetails")
  @ApiOperation({ summary: "IFSC lookup: IFSC, Bank, Branch, City, State, Address" })
  async fetchIfscDetails(@Query() dto: IfscQueryDto) {
    return ciSuccess(await this.globally.fetchIfscDetails(String(dto.ifsc ?? "")));
  }

  @Get("getCommTemplate")
  @ApiOperation({ summary: "The module's message template with the record's details filled in (Found, Subject, Body, RawSubject, RawBody)" })
  async getCommTemplate(@Query() dto: CommTemplateQueryDto) {
    return ciSuccess(await this.globally.getCommTemplate(dto.orgId, postInt(dto, "ModuleUID"), String(dto.Channel ?? "Email").trim(), postInt(dto, "RecordUID")));
  }
}
