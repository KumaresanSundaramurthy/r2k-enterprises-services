import { Injectable, Logger } from "@nestjs/common";

// Upstash REST store used by the CI3 frontend for a few browser-readable flags (e.g. has-price-lists).
@Injectable()
export class UpstashService {
  private readonly logger = new Logger(UpstashService.name);

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    if (!url || !token) return;

    const command = ["SET", key, typeof value === "string" ? value : JSON.stringify(value)];
    if (ttlSeconds > 0) command.push("EX", String(ttlSeconds));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(command),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      this.logger.warn(`Upstash SET ${key} failed: ${(err as Error).message}`);
    }
  }
}
