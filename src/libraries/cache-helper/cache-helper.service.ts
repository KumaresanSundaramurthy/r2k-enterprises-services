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

  // r2k-customer-group-types: global list shared by every organisation, no expiry
  async storeCustomerGroupTypes(types: string[]): Promise<void> {
    if (types.length > 0) await this.upstash.set(this.redis.globalKey("customer-group-types"), types, 0);
  }
}
