import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

// Modules.ModuleTbl flags that decide which modules a settings page lists
type ModuleFlag = "IsThermalPrint" | "IsPrefix" | "IsPrintTemplate";

// Global lists and module lists the settings pages share (CI3 Global_model / Organisation_model lookups).
@Injectable()
export class SettingsLookupsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getThermalPrintModules / getPrefixModules / getPrintTemplateModules — active modules with the flag, in menu order
  async modulesWith(flag: ModuleFlag): Promise<Row[]> {
    const columns = flag === "IsPrintTemplate" ? ["ModuleUID", "Name", "DisplayName"] : ["ModuleUID", "Name"];
    return this.read("Modules.ModuleTbl").select(columns).where({ [flag]: 1, IsActive: 1, IsDeleted: 0 }).orderBy("Sorting", "asc");
  }

  // { ModuleUID: Name } — the map CI3 builds from the module list
  async moduleNames(flag: ModuleFlag): Promise<Record<number, string>> {
    const names: Record<number, string> = {};
    for (const row of await this.modulesWith(flag)) names[Number(row.ModuleUID)] = String(row.Name);
    return names;
  }

  // getDiscountTypeInfo / getProductTypeInfo / getProductTaxInfo / getTaxDetailsInfo / getSalutations
  async discountTypes(): Promise<Row[]> {
    return this.activeSorted("Global.DiscountTypeTbl", ["DiscountTypeUID", "Name", "DisplayName", "Symbol", "UpdatedOn"]);
  }

  async productTypes(): Promise<Row[]> {
    return this.activeSorted("Global.ProductTypeTbl", ["ProductTypeUID", "Name", "UpdatedOn"]);
  }

  async productTaxes(): Promise<Row[]> {
    return this.activeSorted("Global.ProductTaxTbl", ["ProductTaxUID", "Name", "UpdatedOn"]);
  }

  async taxDetails(): Promise<Row[]> {
    return this.activeSorted("Global.TaxDetailsTbl", ["TaxDetailsUID", "TaxName", "Percentage", "CGST", "SGST", "IGST", "UpdatedOn"]);
  }

  async salutations(): Promise<Row[]> {
    return this.activeSorted("Global.SalutationTbl", ["SalutationUID", "SalutationName", "Sorting"]);
  }

  private activeSorted(table: string, columns: string[]): Promise<Row[]> {
    return this.read(table).select(columns).where({ IsDeleted: 0, IsActive: 1 }).orderBy("Sorting", "asc");
  }
}
