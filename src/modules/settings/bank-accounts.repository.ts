import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";
import { Row } from "./settings-lookups.repository";

const BANKS = "Organisation.OrgBankAccountsTbl";

// Organisation_model bank-account queries.
@Injectable()
export class BankAccountsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getBankAccountList — cash first, then the default, then oldest first
  async list(orgUID: number): Promise<Row[]> {
    return this.read(BANKS)
      .select(
        "BankAccountUID", "AccountName", "BankName", "AccountNumber",
        "IFSC", "BranchName", "UPIId", "UPINumber",
        "OpeningBalance", "Notes", "IsDefault", "IsCash",
        "CreatedOn", "UpdatedOn"
      )
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1 })
      .orderBy([
        { column: "IsCash", order: "desc" },
        { column: "IsDefault", order: "desc" },
        { column: "BankAccountUID", order: "asc" },
      ]);
  }

  async find(orgUID: number, bankUID: number): Promise<Row | null> {
    const row = await this.read(BANKS).select("*").where({ BankAccountUID: bankUID, OrgUID: orgUID, IsDeleted: 0 }).first();
    return row ?? null;
  }

  // getBankBalance — opening + customer receipts − vendor payments + transfers in − transfers out
  async balance(orgUID: number, bankUID: number): Promise<number> {
    const result = await this.read.raw(
      `SELECT BA.OpeningBalance,
              COALESCE(SUM(CASE WHEN P.PartyType = 'C' AND P.IsDeleted = 0 AND P.IsActive = 1 THEN P.Amount ELSE 0 END), 0) AS TotalIn,
              COALESCE(SUM(CASE WHEN P.PartyType = 'S' AND P.IsDeleted = 0 AND P.IsActive = 1 THEN P.Amount ELSE 0 END), 0) AS TotalOut,
              COALESCE((SELECT SUM(FT.Amount) FROM Transaction.FundTransfersTbl FT WHERE FT.ToBankUID = BA.BankAccountUID AND FT.IsDeleted = 0), 0) AS TransferIn,
              COALESCE((SELECT SUM(FT.Amount) FROM Transaction.FundTransfersTbl FT WHERE FT.FromBankUID = BA.BankAccountUID AND FT.IsDeleted = 0), 0) AS TransferOut
         FROM Organisation.OrgBankAccountsTbl BA
         LEFT JOIN Transaction.PaymentsTbl P ON P.BankAccountUID = BA.BankAccountUID
        WHERE BA.BankAccountUID = ? AND BA.OrgUID = ? AND BA.IsDeleted = 0
        GROUP BY BA.BankAccountUID, BA.OpeningBalance`,
      [bankUID, orgUID]
    );
    const row = result[0][0];
    if (!row) return 0;
    return Number(row.OpeningBalance) + Number(row.TotalIn) - Number(row.TotalOut) + Number(row.TransferIn) - Number(row.TransferOut);
  }

  async insert(data: Row, trx: Knex.Transaction): Promise<number> {
    const [id] = await trx(BANKS).insert(data);
    return Number(id);
  }

  async update(orgUID: number, where: Row, data: Row, trx?: Knex.Transaction): Promise<number> {
    return this.writer(trx)(BANKS).where({ ...where, OrgUID: orgUID }).update(data);
  }

  // One default bank per organisation
  async clearDefault(orgUID: number, userUID: number, trx: Knex.Transaction): Promise<void> {
    await trx(BANKS).where({ OrgUID: orgUID, IsDeleted: 0 }).update({ IsDefault: 0, UpdatedBy: userUID });
  }

  async insertTransfer(data: Row, trx: Knex.Transaction): Promise<number> {
    const [id] = await trx("Transaction.FundTransfersTbl").insert(data);
    return Number(id);
  }
}
