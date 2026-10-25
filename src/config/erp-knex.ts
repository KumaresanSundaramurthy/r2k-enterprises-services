import Knex from "knex";
import type { Field } from "mysql2/typings/mysql/lib/parsers/typeCast";

// Rows are returned as strings (NULL stays null), matching how CI3's mysqli driver returns them.
// Session payloads built from these rows are shared with the PHP app through Redis, so the
// JSON shape must be the same whichever app wrote it.
function castAllToString(field: Field): string | null {
  // mysqlnd turns BIT columns (IsLocked, IsEmailVerified, ...) into their decimal value, e.g. "1"
  if (field.type === "BIT") {
    const bytes = field.buffer();
    if (bytes === null) return null;
    let value = BigInt(0);
    for (const byte of bytes) value = (value << BigInt(8)) | BigInt(byte);
    return value.toString();
  }
  return field.string();
}

// No default database: every ERP query names its schema explicitly (Users.UserTbl, Organisation.OrganisationTbl, ...).
function createErpKnex(host: string | undefined) {
  return Knex({
    client: "mysql2",
    connection: {
      host,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      typeCast: castAllToString,
    },
    pool: { min: 1, max: 10 },
  });
}

export const erpKnexRead = createErpKnex(process.env.READ_DB_HOSTNAME);
export const erpKnexWrite = createErpKnex(process.env.WRITE_DB_HOSTNAME);
