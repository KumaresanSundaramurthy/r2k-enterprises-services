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
  margin?: { top?: string; right?: string; bottom?: string; left?: string };
  timeoutMs?: number;
  // Puppeteer footer template — use <span class="pageNumber"> / <span class="totalPages">
  footerTemplate?: string;
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
        ...(options.footerTemplate
          ? { displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: options.footerTemplate }
          : {}),
        timeout,
      });
      return Buffer.from(pdf);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Load html in headless Chrome, split it into per-page HTML strings at A4 height (1123 px),
   * breaking only at item row (<tr data-item-idx="N">) boundaries. Each returned string is a
   * complete HTML document containing only the rows for that page. Non-last pages have the
   * summary/totals section hidden; the last page shows it. {{PRINT_PAGE_NUM}} and
   * {{PRINT_TOTAL_PAGES}} tokens are replaced in every page. Returns [html] unchanged when
   * the content fits on a single page or no data-item-idx rows are found.
   */
  async paginateHtml(html: string): Promise<string[]> {
    /* Usable content height per A4 page (px at 96 dpi):
       A4 = 1123 px, footer zone = 60 px, top breathing room = 40 px. */
    const PAGE_H = 1123 - 60 - 40; // 1023 px

    /* Zero html+body margins so row y-positions start at 0. */
    const measHtml = html.includes("</head>")
      ? html.replace("</head>", "<style>html,body{margin:0!important;}</style></head>")
      : "<style>html,body{margin:0!important;}</style>" + html;

    const browser = await this.getBrowser();
    const page = await browser.newPage();
    try {
      /* 794 px = A4 width at 96 dpi. 30000 px height puts all rows in viewport. */
      await page.setViewport({ width: 794, height: 30000 });

      // === 1. Measure item row positions ===
      await page.setContent(measHtml, { waitUntil: "domcontentloaded", timeout: 15000 });
      const itemPos: { idx: number; bottom: number }[] = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("tr[data-item-idx]")).map((tr) => ({
          idx: parseInt((tr as HTMLElement).getAttribute("data-item-idx") ?? "0", 10),
          bottom: tr.getBoundingClientRect().bottom,
        }));
      });

      if (itemPos.length === 0) return [html];

      // === 2. Determine page break item indices ===
      const pageEndIdx: number[] = [];
      let offset = 0;
      const lastIdx = itemPos[itemPos.length - 1].idx;

      while (true) {
        const clipEnd = offset + PAGE_H;
        let lastFitIdx = -1;
        for (let i = itemPos.length - 1; i >= 0; i--) {
          if (itemPos[i].bottom <= clipEnd) { lastFitIdx = itemPos[i].idx; break; }
        }
        if (lastFitIdx < 0 || lastFitIdx === lastIdx) {
          pageEndIdx.push(lastIdx);
          break;
        }
        pageEndIdx.push(lastFitIdx);
        const breakBottom = itemPos.find((p) => p.idx === lastFitIdx)!.bottom;
        offset = breakBottom;
      }

      const totalPages = pageEndIdx.length;
      if (totalPages <= 1) return [html];

      // === 3. Generate HTML for each page via DOM manipulation ===
      const pageHtmls: string[] = [];
      let prevEnd = -1;

      for (let p = 0; p < totalPages; p++) {
        const startIdx = prevEnd + 1;
        const endIdx   = pageEndIdx[p];
        const isLast   = p === totalPages - 1;

        /* Reload fresh HTML for each page so there is no stale state. */
        await page.setContent(measHtml, { waitUntil: "domcontentloaded", timeout: 10000 });

        const rawHtml: string = await page.evaluate(
          (start: number, end: number, last: boolean) => {
            /* Show only item rows for this page */
            document.querySelectorAll("tr[data-item-idx]").forEach((tr) => {
              const idx = parseInt((tr as HTMLElement).getAttribute("data-item-idx") ?? "0", 10);
              (tr as HTMLElement).style.display = idx >= start && idx <= end ? "" : "none";
            });

            /* Non-last pages: hide everything after the items table (totals, notes, etc.) */
            if (!last) {
              const lastItem = document.querySelector(`tr[data-item-idx="${end}"]`);
              if (lastItem) {
                /* Walk up from the items table, hiding all subsequent siblings at every level. */
                let el: Element | null = lastItem.closest("table");
                while (el && el !== document.body) {
                  let sib = el.nextElementSibling;
                  while (sib) {
                    (sib as HTMLElement).style.display = "none";
                    sib = sib.nextElementSibling;
                  }
                  el = el.parentElement;
                }
              }
            }

            return document.documentElement.outerHTML;
          },
          startIdx, endIdx, isLast
        );

        const pageHtml = rawHtml
          .replace(/\{\{PRINT_PAGE_NUM\}\}/g, String(p + 1))
          .replace(/\{\{PRINT_TOTAL_PAGES\}\}/g, String(totalPages));

        pageHtmls.push(pageHtml);
        prevEnd = endIdx;
      }

      return pageHtmls;
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
