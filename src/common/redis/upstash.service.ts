import { Injectable, Logger } from "@nestjs/common";

// Upstash REST store shared with CI3 (CI3's Upstashservice): browser-readable flags and caches such as credit-settings.
@Injectable()
export class UpstashService {
  private readonly logger = new Logger(UpstashService.name);

  // JSON values come back decoded (CI3 json_decode($raw, true)); anything else is returned as stored.
  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = await this.command<string | null>(["GET", key]);
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const command = ["SET", key, typeof value === "string" ? value : JSON.stringify(value)];
    if (ttlSeconds > 0) command.push("EX", String(ttlSeconds));
    await this.command(command);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.command(["DEL", ...keys]);
  }

  // HSET key field value [field value ...] — CI3 hmset(); values are stored as given
  async hset(key: string, fields: Record<string, string>): Promise<void> {
    const pairs = Object.entries(fields).flat();
    if (pairs.length > 0) await this.command(["HSET", key, ...pairs]);
  }

  async hdel(key: string, ...fields: string[]): Promise<void> {
    if (fields.length > 0) await this.command(["HDEL", key, ...fields]);
  }

  // Several commands in one request (Upstash /pipeline), like CI3 pipeline()
  async pipeline(commands: string[][]): Promise<void> {
    const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    if (!url || !token || commands.length === 0) return;
    try {
      const res = await fetch(`${url}/pipeline`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      this.logger.warn(`Upstash pipeline (${commands.map((c) => c[0]).join(",")}) failed: ${(err as Error).message}`);
    }
  }

  // Cache failures never break a request: they are logged and treated as a miss.
  private async command<T>(command: string[]): Promise<T | null> {
    const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    if (!url || !token) return null;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: string };
      if (body.error) throw new Error(body.error);
      return body.result ?? null;
    } catch (err) {
      this.logger.warn(`Upstash ${command[0]} ${command[1]} failed: ${(err as Error).message}`);
      return null;
    }
  }
}
