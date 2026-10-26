import Knex from "knex";
import { castBitsToBoolean } from "./mysql";

// No default database: every query names its schema explicitly (Products.ProductTbl, Users.UserTbl, ...).
function createKnex(host: string | undefined) {
  return Knex({
    client: "mysql2",
    connection: {
      host,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      decimalNumbers: true,
      typeCast: castBitsToBoolean,
    },
    pool: { min: 0, max: Number(process.env.DB_POOL_MAX || 10) },
  });
}

export const knexRead = createKnex(process.env.READ_DB_HOSTNAME);
export const knexWrite = createKnex(process.env.WRITE_DB_HOSTNAME);
