import { Injectable } from "@nestjs/common";
import { toInt } from "../../common/utils/php-compat";
import { CiValidationError } from "../../core/response/ci-response";
import { BarcodeConfigRepository, CodeType, Row } from "./barcode-config.repository";

type Form = Record<string, unknown>;

// Shown until the organisation saves its own settings (CI3 Barcodeconfig::index)
const BARCODE_DEFAULTS: Row = { ConfigUID: 0, Format: "CODE128", BarWidth: 2, Width: 2, Height: 60, ShowValue: 1, FontSize: 11, LineColor: "#000000", IsEnabled: 1 };
const QRCODE_DEFAULTS: Row = { ConfigUID: 0, Size: 100, ErrorLevel: "M", DarkColor: "#000000", LightColor: "#ffffff", IsEnabled: 1 };

const MISSING_LAYOUT_TABLE = "Label layouts are not set up yet. Run database/migrations/barcode_label_designer.sql to create Products.BarcodeLabelLayoutTbl.";

// Bit columns come back as "1" / "0" (or a Buffer); CI3 casts them with (int)(bool)
const flag = (value: unknown): number => (Buffer.isBuffer(value) ? (value[0] ? 1 : 0) : Number(value ?? 0) ? 1 : 0);
// PHP (int)($post[x] ?? default): the default only when the field is absent
const intOr = (form: Form, key: string, fallback: number): number => (form[key] === undefined || form[key] === null ? fallback : toInt(form[key], 0));
const textOr = (form: Form, key: string, fallback: string): string => (form[key] === undefined || form[key] === null ? fallback : String(form[key]));
const typeOf = (value: unknown): CodeType => (value === "qrcode" ? "qrcode" : "barcode");

// CI3 Barcodeconfig controller (Settings → Barcode / QR code)
@Injectable()
export class BarcodeConfigService {
  constructor(private readonly repo: BarcodeConfigRepository) {}

  // index — the barcode and QR code settings, with CI3's defaults when none are saved
  async getPageData(orgUID: number) {
    const [barcode, qrcode] = await Promise.all([this.repo.config(orgUID, "barcode"), this.repo.config(orgUID, "qrcode")]);
    const BarcodeConfig: Row = barcode ?? { ...BARCODE_DEFAULTS };
    const QRConfig: Row = qrcode ?? { ...QRCODE_DEFAULTS };
    BarcodeConfig.ShowValue = flag(BarcodeConfig.ShowValue);
    BarcodeConfig.IsEnabled = flag(BarcodeConfig.IsEnabled);
    QRConfig.IsEnabled = flag(QRConfig.IsEnabled);
    return { BarcodeConfig, QRConfig };
  }

  // saveConfig — ConfigType 'qrcode' saves the QR code settings, anything else the barcode settings
  async saveConfig(orgUID: number, userUID: number, form: Form) {
    const type = typeOf(form.ConfigType);
    const data: Row =
      type === "barcode"
        ? {
            Format: textOr(form, "Format", "CODE128"),
            BarWidth: intOr(form, "BarWidth", 2),
            Height: intOr(form, "Height", 60),
            ShowValue: Number(form.ShowValue) === 1 ? 1 : 0,
            FontSize: intOr(form, "FontSize", 11),
            LineColor: textOr(form, "LineColor", "#000000"),
            IsEnabled: Number(form.IsEnabled) === 1 ? 1 : 0,
          }
        : {
            Size: intOr(form, "Size", 100),
            ErrorLevel: textOr(form, "ErrorLevel", "M"),
            DarkColor: textOr(form, "DarkColor", "#000000"),
            LightColor: textOr(form, "LightColor", "#ffffff"),
            IsEnabled: Number(form.IsEnabled) === 1 ? 1 : 0,
          };
    await this.repo.saveConfig(orgUID, type, data, userUID);
    return { Message: "Configuration saved successfully." };
  }

  // getLayout — the saved label layout (FieldsLayout / BarcodeConfig as JSON), or null
  async getLayout(orgUID: number, rawType: unknown) {
    const row = await this.layoutCall(() => this.repo.layout(orgUID, typeOf(rawType)));
    if (row) {
      row.FieldsLayout = BarcodeConfigService.json(row.FieldsLayout);
      row.BarcodeConfig = row.BarcodeConfig ? BarcodeConfigService.json(row.BarcodeConfig) : null;
    }
    return { Layout: row ?? null };
  }

  // saveLayout — FieldsLayout must be valid JSON
  async saveLayout(orgUID: number, userUID: number, form: Form) {
    const fields = textOr(form, "FieldsLayout", "[]");
    if (BarcodeConfigService.json(fields) === null) throw new CiValidationError("Invalid layout data.");
    const data: Row = {
      LabelSizeKey: textOr(form, "LabelSizeKey", "50x25"),
      LabelWidthPx: intOr(form, "LabelWidthPx", 189),
      LabelHeightPx: intOr(form, "LabelHeightPx", 94),
      FieldsLayout: fields,
    };
    await this.layoutCall(() => this.repo.saveLayout(orgUID, typeOf(form.LabelType), data, userUID));
    return { Message: "Layout saved successfully." };
  }

  // The layout table is created by a migration that has not been run everywhere
  private async layoutCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if ((err as { code?: string }).code === "ER_NO_SUCH_TABLE") throw new CiValidationError(MISSING_LAYOUT_TABLE);
      throw err;
    }
  }

  // PHP json_decode: the decoded value, or null when the text is not JSON (or is JSON null)
  private static json(value: unknown): unknown {
    if (value !== null && typeof value === "object") return value;
    try {
      return JSON.parse(String(value ?? ""));
    } catch {
      return null;
    }
  }
}
