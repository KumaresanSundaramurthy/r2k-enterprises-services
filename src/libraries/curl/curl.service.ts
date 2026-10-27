import { Injectable, Logger } from "@nestjs/common";

export interface CurlOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** Outgoing HTTP calls to third-party APIs (CI3 Curlservice). Network failures return null, never throw. */
@Injectable()
export class CurlService {
  private readonly logger = new Logger(CurlService.name);

  async json<T = Record<string, unknown>>(url: string, options: CurlOptions = {}): Promise<T | null> {
    try {
      const res = await fetch(url, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
        redirect: "follow",
      });
      return (await res.json()) as T;
    } catch (err) {
      this.logger.warn(`${options.method ?? "GET"} ${new URL(url).host} failed: ${(err as Error).message}`);
      return null;
    }
  }
}
