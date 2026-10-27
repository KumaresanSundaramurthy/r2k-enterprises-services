import { Injectable, Logger } from "@nestjs/common";
import ExcelJS from "exceljs";
import { escapeHtml, phpDate } from "../../common/utils/php-compat";
import { imageInfo } from "../../common/utils/image-info";

export const EXPORT_TYPES = ["CSV", "Excel", "Pdf", "Print"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

// Organisation header lines (OrgSettingsService.getHeader)
export type ExportOrg = Record<string, string | null> | null;

export interface ExportRequest {
  type: ExportType;
  fileName: string;
  sheetName: string;
  previewName: string;
  headers: string[];
  rows: (string | number)[][];
  org: ExportOrg;
  timezone: string;
  colWidths?: string[];
}

// Pdf / Print → printable HTML the browser prints (or saves as PDF); CSV / Excel → a file download
export type ExportResult =
  | { kind: "html"; html: string }
  | { kind: "file"; fileName: string; contentType: string; body: Buffer };

const GENERATED_FORMAT = "d M Y, h:i A";
const LOGO_HEIGHT = 48;
const LOGO_FETCH_TIMEOUT_MS = 5000;

// PHP fputcsv() quotes a field containing the delimiter, a quote, a backslash, a space or a line break
const csvField = (value: string | number) => {
  const text = String(value);
  return /[",\\ \t\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvLine = (fields: (string | number)[]) => fields.map(csvField).join(",") + "\n";

const clean = (value: string | null | undefined) => {
  const text = (value ?? "").trim();
  return text === "null" ? "" : text;
};

/**
 * List exports shared by every module (CI3 MY_Controller::_sendExport / _buildPrintHtml): an organisation
 * header, the report name with the generated time, then the table.
 */
@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  async build(request: ExportRequest): Promise<ExportResult> {
    switch (request.type) {
      case "Pdf":
      case "Print":
        return { kind: "html", html: this.printHtml(request) };
      case "CSV":
        return {
          kind: "file",
          fileName: `${request.fileName}.csv`,
          contentType: "text/csv; charset=utf-8",
          body: this.csv(request),
        };
      case "Excel":
        return {
          kind: "file",
          fileName: `${request.fileName}.xlsx`,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          body: await this.excel(request),
        };
    }
  }

  private csv(request: ExportRequest): Buffer {
    const { orgName, addressLine, contactLine } = this.orgLines(request.org);
    let out = "﻿";
    if (orgName) out += csvLine([orgName]);
    if (addressLine) out += csvLine([addressLine]);
    if (contactLine) out += csvLine([contactLine]);
    out += csvLine([`${request.previewName} — Generated: ${this.generatedAt(request.timezone)}`]);
    out += "\n";
    out += csvLine(request.headers);
    for (const row of request.rows) out += csvLine(row);
    return Buffer.from(out, "utf8");
  }

  private async excel(request: ExportRequest): Promise<Buffer> {
    const { orgName, addressLine, contactLine } = this.orgLines(request.org);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(request.sheetName);
    const colCount = request.headers.length;

    let r = 1;
    if (await this.addLogo(workbook, sheet, request.org?.Logo)) r = 5;

    const mergedLine = (text: string) => {
      sheet.getCell(r, 1).value = text;
      sheet.mergeCells(r, 1, r, colCount);
      return sheet.getCell(r++, 1);
    };
    mergedLine(orgName).font = { bold: true, size: 14 };
    if (addressLine) mergedLine(addressLine);
    if (contactLine) mergedLine(contactLine);
    mergedLine(`${request.previewName}   |   Generated: ${this.generatedAt(request.timezone)}`).font = {
      bold: true,
      color: { argb: "FF334155" },
    };
    r++;

    const headerRow = sheet.getRow(r++);
    headerRow.values = request.headers;
    for (let c = 1; c <= colCount; c++) {
      const cell = headerRow.getCell(c);
      cell.font = { bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
    }
    for (const row of request.rows) sheet.getRow(r++).values = row;

    // Auto-size from the table cells (the merged header lines are left out, like PhpSpreadsheet)
    for (let c = 0; c < colCount; c++) {
      const longest = Math.max(
        request.headers[c].length,
        ...request.rows.map((row) => String(row[c] ?? "").length)
      );
      sheet.getColumn(c + 1).width = longest + 2;
    }
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  // The organisation logo at A1, 48px high; skipped when it cannot be loaded
  private async addLogo(workbook: ExcelJS.Workbook, sheet: ExcelJS.Worksheet, logoUrl: string | null | undefined): Promise<boolean> {
    if (!logoUrl) return false;
    try {
      const res = await fetch(logoUrl, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) });
      if (!res.ok) return false;
      const buffer = Buffer.from(await res.arrayBuffer());
      const info = imageInfo(buffer);
      if (!info || info.height === 0) return false;
      const imageId = workbook.addImage({ buffer: buffer as unknown as ExcelJS.Buffer, extension: info.extension });
      sheet.addImage(imageId, {
        tl: { col: 0, row: 0 },
        ext: { width: Math.round((info.width * LOGO_HEIGHT) / info.height), height: LOGO_HEIGHT },
      });
      return true;
    } catch (err) {
      this.logger.warn(`Export logo skipped: ${(err as Error).message}`);
      return false;
    }
  }

  private printHtml(request: ExportRequest): string {
    const { org, previewName, headers, rows, colWidths } = request;
    const { orgName, addressParts, contactParts } = this.orgLines(org);
    const logo = org?.Logo ? `<img src="${escapeHtml(org.Logo)}" style="height:48px;object-fit:contain;" alt="Logo">` : "";
    const colGroup = colWidths?.length
      ? `<colgroup>${colWidths.map((width) => `<col style="width:${escapeHtml(width)}">`).join("")}</colgroup>`
      : "";
    const th = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
    const tb = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(String(cell))}</td>`).join("")}</tr>`).join("");

    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${escapeHtml(orgName || previewName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
@page{size:A4 landscape;margin:10mm 15mm;}
body{font-family:Arial,Helvetica,sans-serif;font-size:9px;}
.org-header{text-align:center;border-bottom:2px solid #334155;padding-bottom:8px;margin-bottom:8px;}
.org-logo{margin-bottom:4px;}
.org-name{font-size:14px;font-weight:700;color:#1e293b;margin-bottom:2px;}
.org-addr{color:#475569;font-size:8px;margin-bottom:2px;}
.org-contact{color:#475569;font-size:8px;}
.report-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;}
.report-bar h4{margin:0;font-size:11px;font-weight:700;color:#1e293b;}
.report-bar .gen-date{font-size:8px;color:#64748b;}
table{width:100%;border-collapse:collapse;table-layout:${colGroup ? "fixed" : "auto"};}
th{background:#e2e8f0;padding:5px 6px;text-align:left;border:1px solid #cbd5e1;font-size:8.5px;color:#1e293b;font-weight:700;white-space:nowrap;overflow:hidden;}
td{padding:4px 6px;border:1px solid #e2e8f0;font-size:8px;color:#334155;word-break:break-word;overflow-wrap:break-word;}
tr:nth-child(even) td{background:#f8fafc;}
@media print{@page{size:A4 landscape;margin:10mm 15mm;}}
</style>
</head><body>
<div class="org-header">
${logo ? `<div class="org-logo">${logo}</div>` : ""}
<div class="org-name">${escapeHtml(orgName)}</div>
${addressParts.length ? `<div class="org-addr">${addressParts.map(escapeHtml).join(", ")}</div>` : ""}
${contactParts.length ? `<div class="org-contact">${contactParts.map(escapeHtml).join(" &nbsp;|&nbsp; ")}</div>` : ""}
</div>
<div class="report-bar">
<h4>${escapeHtml(previewName)}</h4>
<span class="gen-date">Generated: ${this.generatedAt(request.timezone)}</span>
</div>
<table>${colGroup}<thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>
</body></html>`;
  }

  // Brand name (else name), "Line1, Line2, City - State, PIN: …" and "Ph | Email | GSTIN"
  private orgLines(org: ExportOrg) {
    const orgName = org ? clean(org.BrandName) || clean(org.Name) : "";
    const addressParts: string[] = [];
    const contactParts: string[] = [];
    if (org) {
      if (clean(org.Line1)) addressParts.push(clean(org.Line1));
      if (clean(org.Line2)) addressParts.push(clean(org.Line2));
      const state = clean(org.StateText);
      const cityState = (clean(org.CityText) + (state ? ` - ${state}` : "")).trim();
      if (cityState) addressParts.push(cityState);
      if (clean(org.Pincode)) addressParts.push(`PIN: ${clean(org.Pincode)}`);
      if (org.MobileNumber) contactParts.push(`Ph: ${org.MobileNumber}`);
      if (org.EmailAddress) contactParts.push(`Email: ${org.EmailAddress}`);
      if (org.GSTIN) contactParts.push(`GSTIN: ${org.GSTIN}`);
    }
    return {
      orgName,
      addressParts,
      contactParts,
      addressLine: addressParts.join(", "),
      contactLine: contactParts.join("  |  "),
    };
  }

  private generatedAt(timezone: string): string {
    return phpDate(GENERATED_FORMAT, new Date(), timezone || "UTC");
  }
}
