import { Injectable } from "@nestjs/common";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { OrganisationRepository, Row } from "./organisation.repository";

// Read side of the CI3 Organisation controller (Settings → Organisation page).
@Injectable()
export class OrganisationService {
  constructor(private readonly repo: OrganisationRepository) {}

  // index — what the CI3 page renders: the organisation (EditOrgData), its billing address and shipping addresses
  async getPageData(orgUID: number) {
    const [org, shipping, maxShipping] = await Promise.all([
      this.repo.findWithBilling(orgUID),
      this.repo.shippingAddresses(orgUID),
      this.repo.maxShippingAddresses(orgUID),
    ]);
    return {
      EditOrgData: org ? { ...org, Logo: org.Logo ? resolveCdnUrl(String(org.Logo)) : "" } : null,
      BillOrgAddrData: org ? OrganisationService.billingAddress(org) : null,
      ShipOrgAddrList: shipping,
      MaxShippingAddr: maxShipping,
    };
  }

  // getBusinessTypes / getIndustryTypes / getBusRegTypes — global lists for the three selects
  async getBusinessTypes() {
    return { Data: await this.repo.lookup("OrgBusinessTypeTbl", "OrgBussTypeUID") };
  }

  async getIndustryTypes() {
    return { Data: await this.repo.lookup("OrgIndustryTypeTbl", "OrgIndTypeUID") };
  }

  async getBusRegTypes() {
    return { Data: await this.repo.lookup("OrgBusinessRegTypeTbl", "OrgBusRegTypeUID") };
  }

  // CI3 mapOrganisationAddress($row, 'B', 'Billing') — null when there is no billing address
  static billingAddress(org: Row): Row | null {
    if (!org.BAddressUID) return null;
    return {
      OrgAddressUID: org.BAddressUID,
      OrgUID: org.OrgUID,
      AddressType: "Billing",
      Line1: org.BLine1,
      Line2: org.BLine2,
      Pincode: org.BPincode,
      City: org.BCity,
      CityText: org.BCityText,
      State: org.BState,
      StateText: org.BStateText,
    };
  }
}
