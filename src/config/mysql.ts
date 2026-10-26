import mysql, { Pool } from "mysql2/promise";
import type { Field, Next } from "mysql2/typings/mysql/lib/parsers/typeCast";

export function castBitsToBoolean(field: Field, next: Next): unknown {
  if (field.type === "BIT" && field.length === 1) {
    const bytes = field.buffer();
    return bytes === null ? null : bytes[0] === 1;
  }
  // tinyint(1) is the standard MySQL convention for boolean flags (as opposed to
  // plain tinyint/tinyint(3) used for small numeric values elsewhere in this schema).
  if (field.type === "TINY" && field.length === 1) {
    const value = field.string();
    return value === null ? null : value === "1";
  }
  return next();
}

// No default database: queries name their schema explicitly. Used for the startup connectivity check.
function createPool(host: string | undefined): Pool {
  return mysql.createPool({
    host,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_MAX || 10),
    decimalNumbers: true,
    typeCast: castBitsToBoolean,
  });
}

export const mysqlReadPool = createPool(process.env.READ_DB_HOSTNAME);
export const mysqlWritePool = createPool(process.env.WRITE_DB_HOSTNAME);

export async function connectMySQL(): Promise<void> {
  const conn = await mysqlWritePool.getConnection();
  await conn.ping();
  conn.release();
  console.log("MySQL connected");
}
