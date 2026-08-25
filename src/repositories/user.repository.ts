import { RowDataPacket, ResultSetHeader } from "mysql2";
import { mysqlReadPool, mysqlWritePool } from "../config/mysql";

export type UserRole = "customer" | "admin";

export interface UserRecord {
  userUID: number;
  orgUID: number;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  createdOn: Date;
  updatedOn: Date;
}

const SELECT = `
  SELECT UserUID AS userUID, OrgUID AS orgUID, Name AS name, Email AS email,
         Password AS password, Role AS role, CreatedOn AS createdOn, UpdatedOn AS updatedOn
  FROM UserTbl
`;

function mapRow(row: RowDataPacket): UserRecord {
  return {
    userUID: row.userUID,
    orgUID: row.orgUID,
    name: row.name,
    email: row.email,
    password: row.password,
    role: row.role,
    createdOn: row.createdOn,
    updatedOn: row.updatedOn,
  };
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const [rows] = await mysqlReadPool.query<RowDataPacket[]>(`${SELECT} WHERE Email = ?`, [email]);
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function findUserById(userUID: number): Promise<UserRecord | null> {
  const [rows] = await mysqlReadPool.query<RowDataPacket[]>(`${SELECT} WHERE UserUID = ?`, [userUID]);
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  orgUID: number;
  role?: UserRole;
}

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  const [result] = await mysqlWritePool.query<ResultSetHeader>(
    `INSERT INTO UserTbl (OrgUID, Name, Email, Password, Role) VALUES (?, ?, ?, ?, ?)`,
    [input.orgUID, input.name, input.email, input.password, input.role || "customer"]
  );
  const user = await findUserById(result.insertId);
  if (!user) throw new Error("Failed to load created user");
  return user;
}
