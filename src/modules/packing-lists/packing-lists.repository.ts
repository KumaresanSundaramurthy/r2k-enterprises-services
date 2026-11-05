import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

export interface PackingListHeader {
  TransUID: number;
  PLDate: string;
  VehicleNumber: string | null;
  LRNumber: string | null;
  TransporterName: string | null;
  Notes: string | null;
}

export interface PackingListLine {
  TransProductUID: number;
  ProductUID: number;
  Quantity: number;
  PackageKind: string | null;
  NumberOfPackages: number;
  NetWeight: number;
  GrossWeight: number;
  CBM: number;
}

/** Packing lists (CI3 Packinglist_model): a packing sub-document of a dispatching transaction (DC, invoice, ...). */
@Injectable()
export class PackingListsRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getAll — the org's packing lists, newest first, with the source document's number and party
  all(orgUID: number): Promise<Row[]> {
    return this.read("Transaction.PackingListTbl as PL")
      .select(
        "PL.PackingListUID",
        "PL.UniqueNumber",
        "PL.PLDate",
        "PL.VehicleNumber",
        "PL.TransporterName",
        "PL.TransUID",
        "Ts.TransNumber",
        "Ts.ModuleUID",
        this.read.raw("COALESCE(??, ??) as ??", ["Cust.Name", "Vend.Name", "PartyName"])
      )
      .leftJoin("Transaction.TransactionsTbl as Ts", (join) => {
        join.on("Ts.TransUID", "PL.TransUID").andOn("Ts.OrgUID", "PL.OrgUID").andOnVal("Ts.IsDeleted", 0);
      })
      .leftJoin("Customers.CustomerTbl as Cust", (join) => {
        join.on("Cust.CustomerUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "C");
      })
      .leftJoin("Vendors.VendorTbl as Vend", (join) => {
        join.on("Vend.VendorUID", "Ts.PartyUID").andOnVal("Ts.PartyType", "S");
      })
      .where({ "PL.OrgUID": orgUID, "PL.IsDeleted": 0 })
      .orderBy("PL.PackingListUID", "desc");
  }

  // getByTransUID — the transaction's packing list (null when none yet)
  async byTransaction(orgUID: number, transUID: number): Promise<Row | null> {
    const row = await this.read("Transaction.PackingListTbl")
      .select("PackingListUID", "OrgUID", "TransUID", "UniqueNumber", "PLDate", "VehicleNumber", "LRNumber", "TransporterName", "Notes", "CreatedBy", "CreatedOn", "UpdatedBy", "UpdatedOn")
      .where({ TransUID: transUID, OrgUID: orgUID, IsDeleted: 0 })
      .first();
    return (row as Row | undefined) ?? null;
  }

  // getItems — the packing list's lines with the source line's product name, part number, unit and description
  items(orgUID: number, packingListUID: number): Promise<Row[]> {
    return this.read("Transaction.PackingListItemsTbl as pli")
      .select(
        "pli.PLItemUID",
        "pli.TransProductUID",
        "pli.ProductUID",
        "pli.Quantity",
        "pli.PackageKind",
        "pli.NumberOfPackages",
        "pli.NetWeight",
        "pli.GrossWeight",
        "pli.CBM",
        "tp.ProductName",
        "tp.PartNumber",
        "tp.PrimaryUnitName",
        "tp.Description"
      )
      .leftJoin("Transaction.TransProductsTbl as tp", (join) => {
        join.on("tp.TransProdUID", "pli.TransProductUID").andOnVal("tp.IsDeleted", 0);
      })
      .where({ "pli.PackingListUID": packingListUID, "pli.OrgUID": orgUID, "pli.IsDeleted": 0 })
      .orderBy("pli.PLItemUID", "asc");
  }

  transaction<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return this.db.write.transaction(work);
  }

  // getNextNumber — PL-001, PL-002 ... from the org's highest PackingListUID
  private async nextNumber(trx: Knex.Transaction, orgUID: number): Promise<string> {
    const row = (await trx("Transaction.PackingListTbl").max("PackingListUID as MaxUID").where({ OrgUID: orgUID }).first()) as Row | undefined;
    return `PL-${String((Number(row?.MaxUID) || 0) + 1).padStart(3, "0")}`;
  }

  /**
   * save — an existing packing list of the org (packingListUID > 0) has its header updated and its lines replaced;
   * otherwise a new one is numbered. Returns the PackingListUID (0 when the update matched nothing).
   */
  async save(trx: Knex.Transaction, orgUID: number, userUID: number, packingListUID: number, header: PackingListHeader, lines: PackingListLine[], now: string): Promise<number> {
    const fields = { PLDate: header.PLDate, VehicleNumber: header.VehicleNumber, LRNumber: header.LRNumber, TransporterName: header.TransporterName, Notes: header.Notes, UpdatedBy: userUID, UpdatedOn: now };
    let uid = packingListUID;
    if (uid > 0) {
      const changed = await trx("Transaction.PackingListTbl").where({ PackingListUID: uid, OrgUID: orgUID, IsDeleted: 0 }).update(fields);
      if (!changed) return 0;
      await trx("Transaction.PackingListItemsTbl").where({ PackingListUID: uid, OrgUID: orgUID, IsDeleted: 0 }).update({ IsDeleted: 1 });
    } else {
      const [insertId] = await trx("Transaction.PackingListTbl").insert({
        OrgUID: orgUID,
        TransUID: header.TransUID,
        UniqueNumber: await this.nextNumber(trx, orgUID),
        ...fields,
        IsDeleted: 0,
        CreatedBy: userUID,
        CreatedOn: now,
      });
      uid = Number(insertId);
    }
    if (lines.length > 0) {
      await trx("Transaction.PackingListItemsTbl").insert(lines.map((line) => ({ PackingListUID: uid, OrgUID: orgUID, ...line, IsDeleted: 0, CreatedBy: userUID, CreatedOn: now })));
    }
    return uid;
  }
}
