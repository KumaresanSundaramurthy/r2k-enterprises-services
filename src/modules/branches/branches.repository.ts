import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { toInt } from "../../common/utils/php-compat";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

// Text columns that have a Tamil copy in BranchesTbl_Lang
export const BRANCH_TEXT_FIELDS = ["Name", "ShortDescription", "ContactPerson", "AddressLine1", "AddressLine2", "StateText", "CityText", "Landmark"] as const;
export type BranchTextField = (typeof BRANCH_TEXT_FIELDS)[number];

// CI3 Branches_model.
@Injectable()
export class BranchesRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getBranchListPaginated — head office first, then by name; Search matches name, code or GSTIN
  async listPaginated(orgUID: number, limit: number, offset: number, search: string, langCode: string): Promise<{ rows: Row[]; totalCount: number }> {
    const useLang = BaseRepository.useLang(langCode);
    const base = () => {
      const qb = this.read("Organisation.BranchesTbl as b")
        .leftJoin("Organisation.BranchTypesTbl as bt", "bt.BranchTypeUID", "b.BranchTypeUID")
        .where({ "b.OrgUID": orgUID, "b.IsDeleted": 0 });
      if (search) this.whereAnyLike(qb, ["b.Name", "b.BranchCode", "b.GSTIN"], search);
      return qb;
    };
    const text = (field: BranchTextField) => this.langColumn(useLang, `bl.${field}`, `b.${field}`, field);

    const countRow = await base().count({ total: "*" }).first();
    const query = base()
      .select(
        "b.BranchUID as BranchUID",
        text("Name"),
        "b.BranchCode as BranchCode",
        text("ShortDescription"),
        text("ContactPerson"),
        "b.MobileNumber as MobileNumber",
        "b.AlternateNumber as AlternateNumber",
        "b.CountryCode as CountryCode",
        "b.CountryISO2 as CountryISO2",
        "b.EmailAddress as EmailAddress",
        "b.GSTIN as GSTIN",
        "b.PANNumber as PANNumber",
        "b.BranchTypeUID as BranchTypeUID",
        "b.IsHeadOffice as IsHeadOffice",
        "b.IsActive as IsActive",
        text("AddressLine1"),
        text("AddressLine2"),
        "b.Pincode as Pincode",
        text("Landmark"),
        "b.StateId as StateId",
        text("StateText"),
        "b.CityId as CityId",
        text("CityText"),
        "b.IsWarehouse as IsWarehouse",
        "b.IsDispatchPoint as IsDispatchPoint",
        "b.IsSalesPoint as IsSalesPoint",
        "b.IsServiceCenter as IsServiceCenter",
        "b.CreatedOn as CreatedOn",
        "b.UpdatedOn as UpdatedOn",
        "bt.Name as BranchTypeName"
      )
      .orderBy([
        { column: "b.IsHeadOffice", order: "desc" },
        { column: "b.Name", order: "asc" },
      ])
      .limit(limit)
      .offset(offset);
    if (useLang) {
      query.leftJoin("Organisation.BranchesTbl_Lang as bl", (on) => {
        on.on("bl.BranchUID", "b.BranchUID").andOnVal("bl.LangCode", "=", langCode);
      });
    }
    return { rows: await query, totalCount: toInt(countRow?.total) };
  }

  // getBranchList — active branches for dropdowns
  async listActive(orgUID: number, langCode: string): Promise<Row[]> {
    const useLang = BaseRepository.useLang(langCode);
    const query = this.read("Organisation.BranchesTbl as b")
      .select("b.BranchUID as BranchUID", this.langColumn(useLang, "bl.Name", "b.Name", "Name"), "b.BranchCode as BranchCode", "b.IsHeadOffice as IsHeadOffice")
      .where({ "b.OrgUID": orgUID, "b.IsDeleted": 0, "b.IsActive": 1 })
      .orderBy("b.IsHeadOffice", "desc")
      .orderBy(useLang ? this.read.raw("COALESCE(bl.Name, b.Name)") : "b.Name", "asc");
    if (useLang) {
      query.leftJoin("Organisation.BranchesTbl_Lang as bl", (on) => {
        on.on("bl.BranchUID", "b.BranchUID").andOnVal("bl.LangCode", "=", langCode);
      });
    }
    return query;
  }

  // getBranchTypesList
  async branchTypes(): Promise<Row[]> {
    return this.read("Organisation.BranchTypesTbl").select("BranchTypeUID", "Name").orderBy("Name", "asc");
  }

  // getBranchCodeExists — another (not deleted) branch of the organisation has the code
  async codeExists(orgUID: number, code: string, excludeUID: number): Promise<boolean> {
    const qb = this.read("Organisation.BranchesTbl").select("BranchUID").where({ OrgUID: orgUID, BranchCode: code.toUpperCase(), IsDeleted: 0 });
    if (excludeUID > 0) qb.whereNot("BranchUID", excludeUID);
    return !!(await qb.first());
  }

  // hasLinkedRecords — transactions, expenses, indirect income or payroll recorded in the branch
  async hasLinkedRecords(branchUID: number, orgUID: number): Promise<boolean> {
    const tables = ["Transaction.TransactionsTbl", "Transaction.ExpensesTbl", "Transaction.IndirectIncomeTbl", "Transaction.PayrollTbl"];
    for (const table of tables) {
      if (await this.read(table).select(this.read.raw("1")).where({ BranchUID: branchUID, OrgUID: orgUID, IsDeleted: 0 }).first()) return true;
    }
    return false;
  }

  async insert(data: Row, trx?: Knex.Transaction): Promise<number> {
    const [id] = await this.writer(trx)("Organisation.BranchesTbl").insert(data);
    return Number(id);
  }

  async update(orgUID: number, branchUID: number, data: Row, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)("Organisation.BranchesTbl").where({ BranchUID: branchUID, OrgUID: orgUID }).update(data);
  }

  // Head office is single per organisation: cleared on every branch before one is set
  async clearHeadOffice(orgUID: number, userUID: number, trx?: Knex.Transaction): Promise<void> {
    await this.writer(trx)("Organisation.BranchesTbl").where({ OrgUID: orgUID, IsDeleted: 0 }).update({ IsHeadOffice: 0, UpdatedBy: userUID });
  }

  // saveBranchLangRow — upsert of the translated text
  async saveLangRow(branchUID: number, langCode: string, text: Record<BranchTextField, string | null>, userUID: number): Promise<void> {
    await this.db
      .write("Organisation.BranchesTbl_Lang")
      .insert({ BranchUID: branchUID, LangCode: langCode, ...text, CreatedBy: userUID, UpdatedBy: userUID })
      .onConflict()
      .merge([...BRANCH_TEXT_FIELDS, "UpdatedBy"]);
  }
}
