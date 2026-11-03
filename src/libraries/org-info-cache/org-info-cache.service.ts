import { Injectable } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { resolveCdnUrl } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";

/**
 * The org-info Redis cache CI3 reads for printed documents (Organisation_model::getOrgInfoCached): the
 * organisation's receipt header with its billing address and the logo as a CDN URL. CI3 caches DevPassword
 * too, so the value is the same shape for both apps; it is never returned to a browser from here.
 */
@Injectable()
export class OrgInfoCacheService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService
  ) {}

  // Deletes and rebuilds org-info (and drops the dispatch-address cache, which CI3 clears with it)
  async refresh(orgUID: number): Promise<void> {
    const info = await this.receiptInfo(orgUID);
    const orgToken = String(info?.OrgToken ?? "");
    const key = orgToken ? this.redis.orgKey("org-info", orgToken) : `org-info-${orgUID}`;
    await this.redis.del(key, this.redis.orgKey("org-dispatch-addresses-shipping", orgToken));
    if (info) {
      await this.redis.set(key, { ...info, Logo: resolveCdnUrl(String(info.Logo ?? "")) }, Number(process.env.LOGIN_EXPIRE_SECS) || 86400);
    }
  }

  // getOrgInfoCached — the cached header (built on a miss), for page previews; DevPassword is left out
  async get(orgUID: number): Promise<Record<string, unknown> | null> {
    const info = await this.receiptInfo(orgUID);
    if (!info) return null;
    const key = info.OrgToken ? this.redis.orgKey("org-info", String(info.OrgToken)) : `org-info-${orgUID}`;
    let cached = await this.redis.get<Record<string, unknown>>(key);
    if (!cached) {
      cached = { ...info, Logo: resolveCdnUrl(String(info.Logo ?? "")) };
      await this.redis.set(key, cached, Number(process.env.LOGIN_EXPIRE_SECS) || 86400);
    }
    const { DevPassword: _devPassword, ...header } = cached;
    return header;
  }

  // Organisation_model::getOrgForReceipt
  private async receiptInfo(orgUID: number): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .read("Organisation.OrganisationTbl as Org")
      .select(
        "Org.Name as Name",
        "Org.BrandName as BrandName",
        "Org.Logo as Logo",
        "Org.GSTIN as GSTIN",
        "Org.MobileNumber as MobileNumber",
        "Org.EmailAddress as EmailAddress",
        "Org.DevPassword as DevPassword",
        "Org.ShortCode as ShortCode",
        "Org.OrgToken as OrgToken",
        "Addr.Line1 as Line1",
        "Addr.Line2 as Line2",
        "Addr.CityText as CityText",
        "Addr.StateText as StateText",
        "Addr.Pincode as Pincode"
      )
      .leftJoin("Organisation.OrgAddressTbl as Addr", (on) => {
        on.on("Addr.OrgUID", "Org.OrgUID").andOnVal("Addr.AddressType", "=", "Billing").andOnVal("Addr.IsDeleted", "=", 0).andOnVal("Addr.IsActive", "=", 1);
      })
      .where({ "Org.OrgUID": orgUID, "Org.IsDeleted": 0 })
      .first();
    return row ?? null;
  }
}
