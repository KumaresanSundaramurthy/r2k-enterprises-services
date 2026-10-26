import { CookieOptions, Request, Response } from "express";

// Same cookie CI3 reads (JWT_COOKIE_NAME). Set COOKIE_DOMAIN to the shared parent domain so both apps see it.
export function sessionCookieName(): string {
  return process.env.JWT_COOKIE_NAME || "r2k_token";
}

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== "false",
    sameSite: "lax",
    path: "/",
    domain: process.env.COOKIE_DOMAIN || undefined,
  };
}

export function setSessionCookie(res: Response, token: string, ttlSeconds: number): void {
  res.cookie(sessionCookieName(), token, { ...baseOptions(), maxAge: ttlSeconds * 1000 });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(sessionCookieName(), baseOptions());
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

// Bearer header first (API clients), then the shared session cookie (browsers).
export function readSessionToken(req: Request): string | undefined {
  const auth = req.headers.authorization?.trim();
  if (auth) {
    // Tolerates "bearer" in any case and a doubled prefix ("Bearer Bearer <jwt>" when pasted into Swagger with the prefix)
    const token = auth.replace(/^(bearer\s+)+/i, "").trim();
    return token && token !== auth ? token : undefined;
  }
  return readCookie(req, sessionCookieName());
}
