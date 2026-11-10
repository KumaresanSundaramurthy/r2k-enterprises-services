import { Injectable } from "@nestjs/common";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { RedisService } from "../../common/redis/redis.service";
import { OrganisationRepository, Row } from "./organisation.repository";

// Read side of the CI3 Organisation controller (Settings → Organisation page).
@Injectable()
export class OrganisationService {
  constructor(
    private readonly repo: OrganisationRepository,
    private readonly redis: RedisService
  ) {}

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

  // getAllOrgDispatchAddresses — shipping addresses with org name, Redis-cached under org-dispatch-addresses-shipping
  async getDispatchAddresses(orgUID: number): Promise<Row[]> {
    const orgToken = await this.repo.orgToken(orgUID);
    const key = orgToken ? this.redis.orgKey("org-dispatch-addresses-shipping", orgToken) : `org-dispatch-addresses-shipping-${orgUID}`;
    const cached = await this.redis.get<Row[]>(key);
    if (cached) return cached;
    const addresses = await this.repo.dispatchAddresses(orgUID);
    await this.redis.set(key, addresses, Number(process.env.LOGIN_EXPIRE_SECS) || 86400);
    return addresses;
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
