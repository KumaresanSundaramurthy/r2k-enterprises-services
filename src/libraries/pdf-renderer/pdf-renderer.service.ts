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

/**
 * HTML → PDF with headless Chrome (the services counterpart of CI3's Dompdf). On Vercel / Linux it runs the
 * @sparticuz/chromium build; elsewhere CHROME_EXECUTABLE_PATH or a locally installed Chrome / Edge. The browser
 * is started once per warm instance and reused; each PDF gets its own page.
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
      // "load" waits for images; web fonts finish separately
      await page.setContent(html, { waitUntil: "load", timeout });
      await page.evaluate("document.fonts.ready.then(() => true)").catch(() => undefined);
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
