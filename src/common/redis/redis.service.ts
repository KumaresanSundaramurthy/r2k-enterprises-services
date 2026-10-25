import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import Redis from "ioredis";

/**
 * Same Redis instance and key scheme as CI3's Redisservice, so sessions and caches
 * written by either app are readable by the other. Values are JSON-encoded.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      db: Number(process.env.REDIS_DATABASE || 0),
      username: process.env.REDIS_USERNAME || undefined,
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_PROTOCOL === "tls" || process.env.REDIS_PROTOCOL === "rediss" ? {} : undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    this.client.on("error", (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }

  // S for local/dev/staging, P for production — mirrors CI3's ENVIRONMENT (CI_ENV, default production).
  private envFlag(): string {
    return (process.env.CI_ENV || "production") === "production" ? "P" : "S";
  }

  envKey(key: string): string {
    return `${this.envFlag()}-${key}`;
  }

  orgKey(type: string, orgToken: string): string {
    return orgToken ? `${orgToken.toLowerCase()}-${this.envFlag()}-${type}` : type;
  }

  globalKey(type: string): string {
    return `r2k-${type}`;
  }

  userKey(type: string, userUID: number | string, orgToken: string): string {
    return orgToken ? `${orgToken.toLowerCase()}-${this.envFlag()}-${type}-${userUID}` : `${type}-${userUID}`;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.run(() => this.client.get(key));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async ttl(key: string): Promise<number> {
    return this.run(() => this.client.ttl(key));
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.run(() => this.client.set(key, JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSeconds))));
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.run(() => this.client.del(...keys));
  }

  private async run<T>(command: () => Promise<T>): Promise<T> {
    try {
      if (this.client.status === "wait") {
        await this.client.connect();
      }
      return await command();
    } catch (err) {
      this.logger.error(`Redis command failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException("Service temporarily unavailable. Please try again in a few minutes.");
    }
  }
}
