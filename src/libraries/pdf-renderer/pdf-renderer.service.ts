import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { existsSync } from "fs";
import type { Browser, PaperFormat } from "puppeteer-core";

// Both packages are ES modules. The literal import() calls compile to require(), which Node 22.12+ (the declared
// runtime) loads and Vercel's file tracing can follow; older local Node versions fall back to a native import().
const nativeImport = new Function("specifier", "return import(specifier)") as <T>(specifier: string) => Promise<T>;
async function loadEsm<T>(specifier: string, viaRequire: () => Promise<T>): Promise<T> {
  try {
    return await viaRequire();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ERR_REQUIRE_ESM") throw err;
    return nativeImport<T>(specifier);
  }
}

// Chrome / Edge on a developer machine (the bundled @sparticuz/chromium binary is Linux-only)
const LOCAL_BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const PAPER_FORMATS: Record<string, PaperFormat> = {
  A3: "A3",
  A4: "A4",
  A5: "A5",
  A6: "A6",
  LETTER: "Letter",
  LEGAL: "Legal",
  TABLOID: "Tabloid",
  LEDGER: "Ledger",
};

export interface PdfOptions {
  paperSize?: string;
  // CSS margins used when the HTML has no @page margin of its own
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  // How long to wait for images / fonts referenced by the HTML
  timeoutMs?: number;
}

/*
 * Font cache: Google Fonts CSS URL → inlined CSS with every woff2 as a base64 data: URI.
 * Populated lazily on first use; lives for the lifetime of the warm Vercel instance.
 * On cache-hit the font bytes are served synchronously from memory in <1 ms.
 */
const fontCss = new Map<string, string>();

/*
 * Fetches a Google Fonts CSS URL and replaces every remote woff2 URL with a base64 data: URI.
 * All font files are downloaded in parallel to minimise latency.
 * The result is cached so a given font is fetched at most once per warm instance.
 */
async function fetchInlinedFontCss(googleFontsUrl: string): Promise<string> {
  const cached = fontCss.get(googleFontsUrl);
  if (cached) return cached;

  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const cssText = await fetch(googleFontsUrl, { headers: { "User-Agent": ua } }).then((r) => r.text());

  const woff2Urls = [...new Set([...cssText.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];

  const encoded = await Promise.all(
    woff2Urls.map(async (url) => {
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      const mime = url.endsWith(".woff2") ? "font/woff2" : "font/woff";
      return { url, dataUri: `data:${mime};base64,${Buffer.from(buf).toString("base64")}` };
    })
  );

  let inlined = cssText;
  for (const { url, dataUri } of encoded) {
    inlined = inlined.split(`url(${url})`).join(`url(${dataUri})`);
  }

  fontCss.set(googleFontsUrl, inlined);
  return inlined;
}

/**
 * HTML → PDF with headless Chrome (the services counterpart of CI3's Dompdf). On Vercel / Linux it runs the
 * @sparticuz/chromium build; elsewhere CHROME_EXECUTABLE_PATH or a locally installed Chrome / Edge. The browser
 * is started once per warm instance and reused; each PDF gets its own page.
 *
 * Performance strategy — two-tier font handling via request interception:
 *   • Cache hit  (font already fetched this instance): served from memory in <1 ms → custom font renders.
 *   • Cache miss (first render of a font on this instance): font request is blocked; Chrome uses the
 *     fallback stack (Arial/Helvetica); the font is fetched and cached in the background so the NEXT
 *     render on the same warm instance gets the custom font.
 * Either way Chrome never stalls waiting on a network round-trip, keeping warm-instance render time
 * in the 400–700 ms range.
 */
@Injectable()
export class PdfRendererService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfRendererService.name);
  private browser: Promise<Browser> | null = null;

  static paperFormat(paperSize: string | undefined): PaperFormat {
    return PAPER_FORMATS[String(paperSize ?? "A4").trim().toUpperCase()] ?? "A4";
  }

  async render(html: string, options: PdfOptions = {}): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      const timeout = options.timeoutMs ?? 15000;

      /* Intercept Google Fonts requests.
         Cache hit  → respond immediately from memory (custom font, zero network wait).
         Cache miss → abort the request so Chrome doesn't block; kick off a background fetch
                      so the next render on this warm instance will get the cached font. */
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const url = req.url();
        const isFontApi = url.includes("fonts.googleapis.com");
        const isFontFile = url.includes("fonts.gstatic.com");

        if (isFontApi) {
          const cached = fontCss.get(url);
          if (cached) {
            req.respond({ status: 200, contentType: "text/css; charset=utf-8", body: cached });
          } else {
            req.abort();
            // Background fetch — no await, result lands in cache for next render
            fetchInlinedFontCss(url).catch(() => undefined);
          }
        } else if (isFontFile) {
          // Individual woff2 files are already embedded when fetched via fetchInlinedFontCss
          req.abort();
        } else {
          req.continue();
        }
      });

      /* domcontentloaded: don't wait for any external resources — fonts are served from cache
         or aborted above, so there is nothing to wait for. */
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout });

      const pdf = await page.pdf({
        format: PdfRendererService.paperFormat(options.paperSize),
        printBackground: true,
        preferCSSPageSize: true,
        margin: options.margin,
        timeout,
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.browser) return;
    const browser = await this.browser.catch(() => null);
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = this.launch().catch((err) => {
        this.browser = null;
        throw err;
      });
    }
    return this.browser;
  }

  private async launch(): Promise<Browser> {
    const puppeteer = (await loadEsm("puppeteer-core", () => import("puppeteer-core"))).default;
    // Vercel always uses the bundled build; elsewhere an installed browser, else the bundled build (Linux)
    const localPath = process.env.VERCEL ? "" : process.env.CHROME_EXECUTABLE_PATH || LOCAL_BROWSERS.find((p) => existsSync(p)) || "";

    let browser: Browser;
    if (localPath) {
      browser = await puppeteer.launch({ executablePath: localPath, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    } else {
      const chromium = (await loadEsm("@sparticuz/chromium", () => import("@sparticuz/chromium"))).default;
      chromium.setGraphicsMode = false;
      browser = await puppeteer.launch({
        args: await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
        executablePath: await chromium.executablePath(),
        headless: "shell",
      });
    }
    browser.on("disconnected", () => {
      this.browser = null;
    });
    this.logger.log("Headless browser started");
    return browser;
  }
}
