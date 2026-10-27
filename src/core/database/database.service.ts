import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { erpKnexRead, erpKnexWrite } from "../../config/erp-knex";

/**
 * Read/write connections for every module (CI3's ReadDb / Dbwrite_model).
 * No default database is selected — every query names its schema (Customers.CustomerTbl, ...).
 * Rows come back as strings exactly like CI3's mysqli, so JSON responses match what the CI3 JS already reads.
 */
@Injectable()
export class DatabaseService {
  get read(): Knex {
    return erpKnexRead;
  }

  get write(): Knex {
    return erpKnexWrite;
  }

  // startTransaction / commitTransaction / rollbackTransaction in one call: rolls back when `work` throws.
  transaction<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return erpKnexWrite.transaction(work);
  }
}
