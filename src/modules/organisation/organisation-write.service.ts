import { Injectable } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { toInt } from "../../common/utils/php-compat";
import { uniqueUploadName } from "../../common/utils/upload-names";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postJsonArray, postString } from "../../core/utils/form-values";
import { FileUploadService } from "../../libraries/file-upload/file-upload.service";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { ShipAddressDto, ShipAddressUpdateDto, OrganisationFormDto } from "./dto/organisation.dto";
import { validationErrorsText } from "../../core/validation/ci-form-validator";
import { buildBillingAddress, buildOrganisationRow, orgFormValidator, shipAddressForPage } from "./organisation-form";
import { OrganisationRepository, Row } from "./organisation.repository";
import { OrganisationService } from "./organisation.service";

// One entry of the ShipAddresses JSON the CI3 page posts
interface PostedShipAddress {
  UID?: number | string;
  Line1?: string;
  Line2?: string;
  Pincode?: string;
  CityId?: number | string;
  CityName?: string;
  StateId?: number | string;
  StateName?: string;
}

// Write side of the CI3 Organisation controller.
@Injectable()
export class OrganisationWriteService {
  constructor(
    private readonly repo: OrganisationRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly fileUpload: FileUploadService,
    private readonly redis: RedisService,
    private readonly orgInfoCache: OrgInfoCacheService
  ) {}

  // updateOrgForm — organisation details, logo, billing address, shipping addresses; then the org caches
  async updateOrganisation(form: OrganisationFormDto, ctx: WriteContext, logo?: Express.Multer.File) {
    const errors = orgFormValidator.validate(form as unknown as Record<string, unknown>);
    if (Object.keys(errors).length > 0) throw new CiValidationError(validationErrorsText(errors));

    const { orgUID, userUID } = ctx;
    await this.repo.updateOrganisation(orgUID, buildOrganisationRow(form, userUID));

    if (logo) {
      const path = "/" + (await this.fileUpload.upload(`org/images/${uniqueUploadName(logo.originalname)}`, logo.buffer, logo.mimetype)).Path;
      await this.repo.updateOrganisation(orgUID, { Logo: path });
    }

    // Billing — a single address, saved when Line 1 is filled
    if (postString(form, "BillAddrLine1")) {
      const billing = buildBillingAddress(form, orgUID, userUID);
      const billingUID = postInt(form, "BillOrgAddressUID");
      if (billingUID > 0) await this.repo.updateAddress(orgUID, billingUID, billing);
      else await this.repo.insertAddress({ ...billing, AddressType: "Billing", CreatedBy: userUID });
    }

    // Shipping — several addresses; UID 0 adds one, a UID updates it
    for (const address of postJsonArray<PostedShipAddress>(form, "ShipAddresses")) {
      if (!address.Line1) continue;
      const data: Row = {
        OrgUID: orgUID,
        AddressType: "Shipping",
        Line1: address.Line1 ?? "",
        Line2: address.Line2 ?? "",
        Pincode: address.Pincode ?? "",
        City: address.CityId || null,
        CityText: address.CityName ?? "",
        State: address.StateId || null,
        StateText: address.StateName ?? "",
        UpdatedBy: userUID,
      };
      const uid = toInt(address.UID);
      if (uid > 0) await this.repo.updateAddress(orgUID, uid, data);
      else await this.repo.insertAddress({ ...data, CreatedBy: userUID });
    }

    for (const uid of postJsonArray<number | string>(form, "DelShipUIDs").map((id) => toInt(id))) {
      if (uid > 0) await this.repo.updateAddress(orgUID, uid, { IsDeleted: 1 });
    }

    await this.orgInfoCache.refresh(orgUID);

    // Fresh billing + shipping UIDs, so the page does not insert the same addresses again on the next save
    const [org, shipping] = await Promise.all([this.repo.findWithBilling(orgUID), this.repo.shippingAddresses(orgUID)]);
    const billing = org ? OrganisationService.billingAddress(org) : null;
    return {
      Message: "Updated Successfully",
      BillAddrUID: billing ? toInt(billing.OrgAddressUID) : 0,
      ShipAddresses: shipping.map(shipAddressForPage),
    };
  }

  // addShipAddress — one more shipping address, within GenSettings->MaxShippingAddr
  async addShipAddress(dto: ShipAddressDto, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    const [current, maxShip] = await Promise.all([this.repo.shippingAddresses(orgUID), this.repo.maxShippingAddresses(orgUID)]);
    if (current.length >= maxShip) {
      throw new CiValidationError(`Only ${maxShip} shipping ${maxShip === 1 ? "address" : "addresses"} can be added. Limit reached.`);
    }

    const address = OrganisationWriteService.shipAddressFields(dto);
    const newUID = await this.repo.insertAddress({
      OrgUID: orgUID,
      AddressType: "Shipping",
      ...OrganisationWriteService.shipAddressRow(address),
      CreatedBy: userUID,
      UpdatedBy: userUID,
    });
    await this.clearDispatchAddressCache(orgUID);

    return {
      Message: "Shipping address added successfully.",
      OrgAddressUID: newUID,
      NewCount: current.length + 1,
      MaxShip: maxShip,
      Address: { OrgAddressUID: newUID, OrgName: await this.repo.orgName(orgUID), ...address, AddressType: "Shipping" },
    };
  }

  // updateShipAddress — edit one shipping address of the organisation
  async updateShipAddress(dto: ShipAddressUpdateDto, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    const addressUID = postInt(dto, "OrgAddressUID");
    if (addressUID <= 0) throw new CiValidationError("Invalid address.");

    const address = OrganisationWriteService.shipAddressFields(dto);
    await this.repo.updateAddress(orgUID, addressUID, { ...OrganisationWriteService.shipAddressRow(address), UpdatedBy: userUID });
    await this.clearDispatchAddressCache(orgUID);

    return {
      Message: "Shipping address updated successfully.",
      OrgAddressUID: addressUID,
      Address: { OrgAddressUID: addressUID, ...address },
    };
  }

  // Trimmed values of the shipping address modal; Line 1 is required
  private static shipAddressFields(dto: ShipAddressDto) {
    const text = (key: keyof ShipAddressDto) => String(dto[key] ?? "").trim();
    const address = {
      Line1: text("Line1"),
      Line2: text("Line2"),
      CityText: text("CityText"),
      CityId: postInt(dto, "CityId"),
      StateText: text("StateText"),
      StateId: postInt(dto, "StateId"),
      Pincode: text("Pincode"),
    };
    if (!address.Line1) throw new CiValidationError("Address Line 1 is required.");
    return address;
  }

  private static shipAddressRow(address: ReturnType<typeof OrganisationWriteService.shipAddressFields>): Row {
    return {
      Line1: address.Line1,
      Line2: address.Line2,
      CityText: address.CityText,
      City: address.CityId || null,
      StateText: address.StateText,
      State: address.StateId || null,
      Pincode: address.Pincode,
    };
  }

  private async clearDispatchAddressCache(orgUID: number): Promise<void> {
    const orgToken = (await this.orgSettings.get(orgUID)).OrgToken;
    await this.redis.del(this.redis.orgKey("org-dispatch-addresses-shipping", orgToken));
  }

}
