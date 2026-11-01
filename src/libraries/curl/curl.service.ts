import { Injectable, Logger } from "@nestjs/common";

export interface CurlOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

// One HTTP exchange: status 0 and `error` set when the request itself failed (curl_error in CI3)
export interface CurlResult<T> {
  status: number;
  data: T | null;
  text: string;
  error: string | null;
}

/** Outgoing HTTP calls to third-party APIs (CI3 Curlservice). Network failures never throw. */
@Injectable()
export class CurlService {
  private readonly logger = new Logger(CurlService.name);

  // Parsed JSON body (any status), or null when the call failed or the body is not JSON.
  async json<T = Record<string, unknown>>(url: string, options: CurlOptions = {}): Promise<T | null> {
    return (await this.request<T>(url, options)).data;
  }

  // Status, raw body and parsed JSON — for APIs whose result depends on the HTTP status (Brevo).
  async request<T = Record<string, unknown>>(url: string, options: CurlOptions = {}): Promise<CurlResult<T>> {
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
      const text = await res.text();
      let data: T | null = null;
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
      return { status: res.status, data, text, error: null };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`${options.method ?? "GET"} ${new URL(url).host} failed: ${message}`);
      return { status: 0, data: null, text: "", error: message };
    }
  }
}
