import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;
export type CodeType = "barcode" | "qrcode";

const CONFIG = "Products.BarcodeConfigTbl";
const LAYOUT = "Products.BarcodeLabelLayoutTbl";

const CONFIG_COLUMNS = [
  "ConfigUID", "OrgUID", "ConfigType", "Format", "BarWidth", "Height", "ShowValue", "FontSize", "LineColor",
  "Size", "ErrorLevel", "DarkColor", "LightColor", "IsEnabled", "IsActive", "IsDeleted", "CreatedBy", "UpdatedBy", "CreatedOn", "UpdatedOn",
];
const LAYOUT_COLUMNS = [
  "LayoutUID", "OrgUID", "LabelType", "LabelSizeKey", "LabelWidthPx", "LabelHeightPx", "FieldsLayout", "BarcodeConfig",
  "IsActive", "IsDeleted", "CreatedBy", "UpdatedBy", "CreatedOn", "UpdatedOn",
];

// Barcodeconfig's Global_model::getSingleRow lookups, plus its inserts / updates
@Injectable()
export class BarcodeConfigRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // The organisation's barcode or QR code settings (one row per type)
  async config(orgUID: number, type: CodeType): Promise<Row | null> {
    const row = await this.read(CONFIG).select(CONFIG_COLUMNS).where({ OrgUID: orgUID, ConfigType: type, IsDeleted: 0 }).first();
    return (row as Row | undefined) ?? null;
  }

  // Insert, or update the existing row. uq_org_configtype also covers deleted rows, so a deleted one is revived.
  async saveConfig(orgUID: number, type: CodeType, data: Row, userUID: number): Promise<void> {
    await this.writer()(CONFIG)
      .insert({ ...data, OrgUID: orgUID, ConfigType: type, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["OrgUID", "ConfigType"])
      .merge({ ...data, UpdatedBy: userUID, IsDeleted: 0 });
  }

  // The organisation's label layout for a type
  async layout(orgUID: number, type: CodeType): Promise<Row | null> {
    const row = await this.read(LAYOUT).select(LAYOUT_COLUMNS).where({ OrgUID: orgUID, LabelType: type, IsDeleted: 0 }).first();
    return (row as Row | undefined) ?? null;
  }

  // Insert, or update the existing layout (uidx_org_type also covers deleted rows, so a deleted one is revived)
  async saveLayout(orgUID: number, type: CodeType, data: Row, userUID: number): Promise<void> {
    await this.writer()(LAYOUT)
      .insert({ ...data, OrgUID: orgUID, LabelType: type, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict(["OrgUID", "LabelType"])
      .merge({ ...data, UpdatedBy: userUID, IsDeleted: 0 });
  }
}
