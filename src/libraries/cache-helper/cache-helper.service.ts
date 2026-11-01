import { Injectable } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { UpstashService } from "../../common/redis/upstash.service";
import { toInt } from "../../common/utils/php-compat";

export interface CustomerGroupCacheRow {
  GroupUID: string | number;
  GroupName: string | null;
  GroupCode: string | null;
  GroupType: string | null;
}

/**
 * Keeps the Upstash caches that CI3's transaction forms read (CI3 Cachehelper), using the same
 * keys and value shapes so both apps read and write them interchangeably.
 */
@Injectable()
export class CacheHelperService {
  constructor(
    private readonly redis: RedisService,
    private readonly upstash: UpstashService
  ) {}

  // {org}-customer-groups: one hash field per GroupUID, rebuilt from the active groups
  async replaceCustomerGroups(orgToken: string, groups: CustomerGroupCacheRow[]): Promise<void> {
    if (groups.length === 0) return;
    const key = this.redis.orgKey("customer-groups", orgToken);
    const fields: Record<string, string> = {};
    for (const group of groups) fields[String(toInt(group.GroupUID))] = this.groupEntry(group);
    await this.upstash.pipeline([
      ["DEL", key],
      ["HSET", key, ...Object.entries(fields).flat()],
    ]);
  }

  // One group in {org}-customer-groups (CI3 upsertCustomerGroup) — after create, update or reactivation
  async writeCustomerGroupEntry(orgToken: string, group: CustomerGroupCacheRow): Promise<void> {
    await this.upstash.hset(this.redis.orgKey("customer-groups", orgToken), { [String(toInt(group.GroupUID))]: this.groupEntry(group) });
  }

  // CI3 removeCustomerGroup — after delete or deactivation
  async removeCustomerGroupEntry(orgToken: string, groupUID: number): Promise<void> {
    await this.upstash.hdel(this.redis.orgKey("customer-groups", orgToken), String(groupUID));
  }

  private groupEntry(group: CustomerGroupCacheRow): string {
    return JSON.stringify({
      GroupUID: toInt(group.GroupUID),
      GroupName: group.GroupName ?? "",
      GroupCode: group.GroupCode ?? "",
      GroupType: group.GroupType ?? "",
    });
  }

  // {org}-customers: one hash field per customer for the transaction forms; also drops the customer:{id} modal cache
  async writeCustomerEntry(orgToken: string, customerUID: number, entry: Record<string, unknown>): Promise<void> {
    await this.upstash.pipeline([
      ["HSET", this.redis.orgKey("customers", orgToken), String(customerUID), JSON.stringify(entry)],
      ["DEL", `customer:${customerUID}`],
    ]);
  }

  // {org}-customers rebuilt from scratch (CI3 syncCustomersCache): DEL clears stale entries, then one HSET
  async replaceCustomers(orgToken: string, entries: Map<number, Record<string, unknown>>): Promise<void> {
    if (entries.size === 0) return;
    const key = this.redis.orgKey("customers", orgToken);
    const pairs = [...entries].flatMap(([customerUID, entry]) => [String(customerUID), JSON.stringify(entry)]);
    await this.upstash.pipeline([
      ["DEL", key],
      ["HSET", key, ...pairs],
    ]);
  }

  // Remove a deleted / deactivated customer from the transaction-form cache
  async removeCustomerEntry(orgToken: string, customerUID: number): Promise<void> {
    await this.upstash.hdel(this.redis.orgKey("customers", orgToken), String(customerUID));
    await this.upstash.del(`customer:${customerUID}`);
  }

  // Store the next number after a customer number was claimed (same shape getCustomerNextNumber reads)
  async storeCreditSettings(orgToken: string, nextCustomerNumber: string, gstinPoints: number): Promise<void> {
    await this.upstash.set(
      this.redis.orgKey("credit-settings", orgToken),
      { cust_next_number: nextCustomerNumber, gstin_points: gstinPoints },
      86400
    );
  }

  // {org}-credit-settings: keeps the other fields and replaces the given ones (CI3 array_merge on the cached value)
  async mergeCreditSettings(orgToken: string, values: Record<string, unknown>): Promise<void> {
    const key = this.redis.orgKey("credit-settings", orgToken);
    const current = await this.upstash.get<Record<string, unknown>>(key);
    await this.upstash.set(key, { ...(current && typeof current === "object" ? current : {}), ...values }, 86400);
  }

  // {org}-vendors: one hash field per vendor for the purchase forms; also drops the vendor:{id} modal cache
  async writeVendorEntry(orgToken: string, vendorUID: number, entry: Record<string, unknown>): Promise<void> {
    await this.upstash.pipeline([
      ["HSET", this.redis.orgKey("vendors", orgToken), String(vendorUID), JSON.stringify(entry)],
      ["DEL", `vendor:${vendorUID}`],
    ]);
  }

  // {org}-vendors rebuilt from scratch (CI3 syncVendorsCache): DEL clears stale entries, then one HSET
  async replaceVendors(orgToken: string, entries: Map<number, Record<string, unknown>>): Promise<void> {
    if (entries.size === 0) return;
    const key = this.redis.orgKey("vendors", orgToken);
    const pairs = [...entries].flatMap(([vendorUID, entry]) => [String(vendorUID), JSON.stringify(entry)]);
    await this.upstash.pipeline([
      ["DEL", key],
      ["HSET", key, ...pairs],
    ]);
  }

  // CI3 removeVendor — after delete or deactivation: the map entry, the modal cache and the vendor's products cache
  async removeVendorEntry(orgToken: string, vendorUID: number): Promise<void> {
    await this.upstash.hdel(this.redis.orgKey("vendors", orgToken), String(vendorUID));
    await this.upstash.del(`vendor:${vendorUID}`, `vendor:${vendorUID}:products`);
  }

  // vendor:{id}:products — dropped when the vendor changes (CI3 keyVendorProducts)
  async removeVendorProducts(vendorUID: number): Promise<void> {
    await this.upstash.del(`vendor:${vendorUID}:products`);
  }

  // {org}-vendor-groups: one hash field per GroupUID, rebuilt from the active groups (CI3 syncVendorGroupsCache)
  async replaceVendorGroups(orgToken: string, groups: CustomerGroupCacheRow[]): Promise<void> {
    if (groups.length === 0) return;
    const key = this.redis.orgKey("vendor-groups", orgToken);
    const pairs = groups.flatMap((group) => [String(toInt(group.GroupUID)), this.groupEntry(group)]);
    await this.upstash.pipeline([
      ["DEL", key],
      ["HSET", key, ...pairs],
    ]);
  }

  // CI3 upsertVendorGroup — after create, update or reactivation
  async writeVendorGroupEntry(orgToken: string, group: CustomerGroupCacheRow): Promise<void> {
    await this.upstash.hset(this.redis.orgKey("vendor-groups", orgToken), { [String(toInt(group.GroupUID))]: this.groupEntry(group) });
  }

  // CI3 removeVendorGroup — after delete or deactivation
  async removeVendorGroupEntry(orgToken: string, groupUID: number): Promise<void> {
    await this.upstash.hdel(this.redis.orgKey("vendor-groups", orgToken), String(groupUID));
  }

  // ── Generic org hashes ({org}-products, -categories, -brands, -sizes): one field per UID ──

  // One entry of an org hash; `alsoDelete` drops related single-entry keys (e.g. product:{id}) in the same call
  async writeOrgHashEntry(type: string, orgToken: string, field: number, entry: Record<string, unknown>, alsoDelete: string[] = []): Promise<void> {
    await this.upstash.pipeline([
      ["HSET", this.redis.orgKey(type, orgToken), String(field), JSON.stringify(entry)],
      ...alsoDelete.map((key) => ["DEL", key]),
    ]);
  }

  // The whole org hash rebuilt from scratch (DEL, then one HSET); an empty map just clears it
  async replaceOrgHash(type: string, orgToken: string, entries: Map<number, Record<string, unknown>>): Promise<void> {
    const key = this.redis.orgKey(type, orgToken);
    const pairs = [...entries].flatMap(([field, entry]) => [String(field), JSON.stringify(entry)]);
    await this.upstash.pipeline(pairs.length > 0 ? [["DEL", key], ["HSET", key, ...pairs]] : [["DEL", key]]);
  }

  async removeOrgHashEntry(type: string, orgToken: string, field: number, alsoDelete: string[] = []): Promise<void> {
    await this.upstash.hdel(this.redis.orgKey(type, orgToken), String(field));
    if (alsoDelete.length > 0) await this.upstash.del(...alsoDelete);
  }

  // {org}-<type> stored as one JSON value (e.g. price-lists), no expiry
  async readOrgValue<T>(type: string, orgToken: string): Promise<T | null> {
    return this.upstash.get<T>(this.redis.orgKey(type, orgToken));
  }

  async writeOrgValue(type: string, orgToken: string, value: unknown): Promise<void> {
    await this.upstash.set(this.redis.orgKey(type, orgToken), value, 0);
  }

  async deleteKeys(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.upstash.del(...keys);
  }

  // r2k-customer-group-types: global list shared by every organisation, no expiry
  async storeCustomerGroupTypes(types: string[]): Promise<void> {
    if (types.length > 0) await this.upstash.set(this.redis.globalKey("customer-group-types"), types, 0);
  }
}
