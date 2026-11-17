import PDFDocument from "pdfkit";
import { escapeHtml } from "../../common/utils/php-compat";

// One export ready to write: the headers, then each row's display texts and which columns are money
export interface ListExportTable {
  title: string;
  orgName: string;
  orgLogo?: string; // base64 data URI or CDN URL; shown centered in the print header
  exportedOn: string; // d M Y
  labels: string[];
  rows: string[][];
  money: boolean[];
}

// PHP fputcsv(): a field is quoted when it holds the delimiter, a quote, the escape character or whitespace
const csvField = (value: string) => (/[",\\\s]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** CI3 TransactionExporter output formats: CSV, Excel 2003 XML (.xls), PDF and the printable page. */
export class ListExportRenderer {
  // _toCsv — UTF-8 BOM + header line + one line per row; BOM tells Excel to open as UTF-8 (prevents â€" garbling)
  static csv(table: ListExportTable): Buffer {
    const lines = [table.labels, ...table.rows].map((fields) => fields.map(csvField).join(",") + "\n");
    return Buffer.from("﻿" + lines.join(""), "utf8");
  }

  // _toExcel — XML Spreadsheet 2003, opens natively in Excel; money columns are numbers
  static excel(table: ListExportTable): Buffer {
    const header = table.labels.map((label) => `<Cell ss:StyleID="H"><Data ss:Type="String">${escapeHtml(label)}</Data></Cell>`).join("");
    const body = table.rows
      .map(
        (row) =>
          "<Row>" +
          row.map((value, i) => `<Cell><Data ss:Type="${table.money[i] ? "Number" : "String"}">${escapeHtml(value)}</Data></Cell>`).join("") +
          "</Row>\n"
      )
      .join("");
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n' +
      '          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n' +
      '<Styles><Style ss:ID="H"><Font ss:Bold="1"/><Interior ss:Color="#1a73e8" ss:Pattern="Solid"/><Font ss:Color="#FFFFFF" ss:Bold="1"/></Style></Styles>\n' +
      `<Worksheet ss:Name="${escapeHtml(table.title)}">\n<Table>\n` +
      `<Row>${header}</Row>\n` +
      body +
      "</Table>\n</Worksheet>\n</Workbook>";
    return Buffer.from(xml, "utf8");
  }

  // _buildHtml('print') — centred logo (if set), org name, title line, numbered table; auto-triggers print on load
  static printHtml(table: ListExportTable): string {
    const logoHtml = table.orgLogo
      ? `<div class="logo"><img src="${table.orgLogo}" alt="${escapeHtml(table.orgName)}"></div>`
      : "";
    let html = '<!DOCTYPE html><html><head><meta charset="UTF-8">';
    html += `<title>${escapeHtml(table.title)}</title><style>`;
    html += "body{font-family:Arial,sans-serif;font-size:10px;margin:16px;color:#222;}";
    html += ".hdr{text-align:center;margin-bottom:10px;}";
    html += ".logo img{max-height:60px;max-width:180px;display:block;margin:0 auto 6px;}";
    html += ".org{font-size:13px;font-weight:bold;}";
    html += ".sub{font-size:9px;color:#555;margin-top:3px;}";
    html += "table{width:100%;border-collapse:collapse;margin-top:10px;}";
    html += "th{background:#1a73e8;color:#fff;padding:5px 7px;text-align:left;font-size:9px;white-space:nowrap;}";
    html += "td{padding:4px 7px;border-bottom:1px solid #e8e8e8;font-size:9px;}";
    html += "tr:nth-child(even) td{background:#f4f8ff;}";
    html += ".num{text-align:right;}.sno{color:#999;text-align:center;}";
    html += "@media print{@page{size:A4 landscape;margin:10mm;}}";
    html += "</style></head><body>";
    html += `<div class="hdr">${logoHtml}<div class="org">${escapeHtml(table.orgName)}</div>`;
    html += `<div class="sub">${escapeHtml(table.title)} &nbsp;|&nbsp; Exported: ${escapeHtml(table.exportedOn)} &nbsp;|&nbsp; ${table.rows.length} records</div></div>`;
    html += '<table><thead><tr><th class="sno">#</th>' + table.labels.map((label) => `<th>${escapeHtml(label)}</th>`).join("") + "</tr></thead><tbody>";
    table.rows.forEach((row, index) => {
      html += `<tr><td class="sno">${index + 1}</td>`;
      html += row.map((value, i) => `<td${table.money[i] ? ' class="num"' : ""}>${escapeHtml(value)}</td>`).join("");
      html += "</tr>";
    });
    html += "</tbody></table>";
    html += "<script>window.onload=function(){window.print();}</script>";
    return html + "</body></html>";
  }

  // _toPdf — the same table on A4 landscape (CI3 rendered the HTML with Dompdf)
  static async pdf(table: ListExportTable): Promise<Buffer> {
    const margin = 28;
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin, info: { Title: table.title } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    const width = doc.page.width - margin * 2;
    const fontSize = 7.5;
    const pad = 4;
    const snoWidth = 22;
    const widths = ListExportRenderer.columnWidths(table, width - snoWidth, fontSize, doc);
    const bottom = () => doc.page.height - margin;

    /* Centred header: logo (if set) → org name → subtitle */
    let headerY = margin;
    if (table.orgLogo) {
      try {
        const dataMatch = table.orgLogo.match(/^data:([^;]+);base64,(.+)$/);
        const imgBuf = dataMatch ? Buffer.from(dataMatch[2], "base64") : await fetch(table.orgLogo).then((r) => r.arrayBuffer()).then((b) => Buffer.from(b));
        const logoMaxH = 36;
        const logoMaxW = 120;
        doc.image(imgBuf, margin + (width - logoMaxW) / 2, headerY, { fit: [logoMaxW, logoMaxH], align: "center" });
        headerY += logoMaxH + 4;
      } catch {
        /* skip logo on error */
      }
    }
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#222222").text(table.orgName, margin, headerY, { width, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#555555").text(`${table.title}  |  Exported: ${table.exportedOn}  |  ${table.rows.length} records`, margin, doc.y + 2, { width, align: "center" });
    let y = doc.y + 8;

    const drawRow = (cells: string[], header: boolean, shade: boolean) => {
      doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
      const texts = [header ? "#" : cells[0], ...cells.slice(1)];
      const cellWidths = [snoWidth, ...widths];
      const height = Math.max(...texts.map((text, i) => doc.heightOfString(text || " ", { width: cellWidths[i] - pad * 2 }))) + pad * 2;
      if (y + height > bottom()) {
        doc.addPage();
        y = margin;
        if (!header) drawRow(["", ...table.labels], true, false);
        doc.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
      }
      if (header || shade) doc.rect(margin, y, width, height).fill(header ? "#1a73e8" : "#f4f8ff");
      let x = margin;
      texts.forEach((text, i) => {
        const align = i === 0 ? "center" : !header && table.money[i - 1] ? "right" : "left";
        doc.fillColor(header ? "#ffffff" : i === 0 ? "#999999" : "#222222").text(text, x + pad, y + pad, { width: cellWidths[i] - pad * 2, align });
        x += cellWidths[i];
      });
      y += height;
      if (!header) doc.moveTo(margin, y).lineTo(margin + width, y).lineWidth(0.5).strokeColor("#e8e8e8").stroke();
    };

    drawRow(["", ...table.labels], true, false);
    table.rows.forEach((row, index) => drawRow([String(index + 1), ...row], false, index % 2 === 1));
    doc.end();
    return done;
  }

  // Widths in proportion to each column's longest text (header included), at least 40pt
  private static columnWidths(table: ListExportTable, available: number, fontSize: number, doc: PDFKit.PDFDocument): number[] {
    doc.font("Helvetica").fontSize(fontSize);
    const natural = table.labels.map((label, i) => {
      const longest = Math.max(doc.widthOfString(label), ...table.rows.slice(0, 500).map((row) => doc.widthOfString(row[i] ?? "")));
      return Math.max(40, Math.min(longest + 10, 220));
    });
    const total = natural.reduce((sum, w) => sum + w, 0);
    return natural.map((w) => (w / total) * available);
  }
}
