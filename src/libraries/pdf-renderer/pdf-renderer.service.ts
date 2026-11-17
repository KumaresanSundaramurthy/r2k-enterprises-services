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
 * Google Fonts CSS → woff2 base64 cache.
 * Key: the full CSS URL (includes family + weights).
 * Value: the CSS with every url(https://fonts.gstatic.com/…) replaced by a data: URI.
 * Lives for the lifetime of the warm function instance so each font is fetched at most once.
 */
const fontCss = new Map<string, string>();

/*
 * Fetch a Google Fonts CSS URL, download every woff2 file it references, replace the
 * remote URLs with base64 data: URIs, and cache the result.  Uses the standard Chrome
 * UA so the API returns woff2 format rather than older formats.
 */
async function inlinedFontCss(googleFontsUrl: string): Promise<string> {
  const cached = fontCss.get(googleFontsUrl);
  if (cached) return cached;

  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const cssText = await fetch(googleFontsUrl, { headers: { "User-Agent": ua } }).then((r) => r.text());

  // Collect unique woff2 URLs from the CSS
  const woff2Urls = [...new Set([...cssText.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];

  // Fetch all font files in parallel
  const encoded = await Promise.all(
    woff2Urls.map(async (url) => {
      const buf = await fetch(url).then((r) => r.arrayBuffer());
      const mime = url.endsWith(".woff2") ? "font/woff2" : "font/woff";
      return { url, dataUri: `data:${mime};base64,${Buffer.from(buf).toString("base64")}` };
    })
  );

  // Replace every remote URL with its data: URI
  let inlined = cssText;
  for (const { url, dataUri } of encoded) {
    inlined = inlined.split(`url(${url})`).join(`url(${dataUri})`);
  }

  fontCss.set(googleFontsUrl, inlined);
  return inlined;
}

/*
 * Replace every <link rel="stylesheet" href="https://fonts.googleapis.com/…"> in the HTML
 * with an inline <style> block that embeds all woff2 files as base64.
 * Returns the patched HTML and whether every font was successfully inlined.
 */
async function inlineFonts(html: string): Promise<{ html: string; allInlined: boolean }> {
  const tags = [...html.matchAll(/<link[^>]+href="(https:\/\/fonts\.googleapis\.com[^"]+)"[^>]*>/g)];
  if (!tags.length) return { html, allInlined: true };

  let result = html;
  let allInlined = true;

  await Promise.all(
    tags.map(async ([tag, url]) => {
      try {
        const css = await inlinedFontCss(url);
        result = result.replace(tag, `<style>${css}</style>`);
      } catch {
        allInlined = false;
      }
    })
  );

  return { html: result, allInlined };
}

/**
 * HTML → PDF with headless Chrome (the services counterpart of CI3's Dompdf). On Vercel / Linux it runs the
 * @sparticuz/chromium build; elsewhere CHROME_EXECUTABLE_PATH or a locally installed Chrome / Edge. The browser
 * is started once per warm instance and reused; each PDF gets its own page.
 *
 * Performance: Google Fonts are pre-fetched and base64-inlined server-side before handing the HTML to Chrome,
 * eliminating the in-browser font network round-trip.  The HTML is loaded with 'domcontentloaded' (no external
 * resource wait) and the font-ready barrier is skipped when all fonts are confirmed inlined.  On warm instances
 * this brings render time from ~1.5 s to ~400–700 ms.
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
      const { html: inlined, allInlined } = await inlineFonts(html);

      /* domcontentloaded skips the external-resource wait; safe because fonts are already embedded. */
      await page.setContent(inlined, { waitUntil: "domcontentloaded", timeout });

      /* Only wait for the font pipeline when at least one font link could not be inlined. */
      if (!allInlined) {
        await page.evaluate("document.fonts.ready.then(() => true)").catch(() => undefined);
      }

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
