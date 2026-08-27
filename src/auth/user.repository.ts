import { Injectable } from "@nestjs/common";
import { knexRead, knexWrite } from "../config/knex";

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

interface UserTblRow {
  UserUID: number;
  OrgUID: number;
  Name: string;
  Email: string;
  Password: string;
  Role: UserRole;
  CreatedOn: Date;
  UpdatedOn: Date;
}

function mapRow(row: UserTblRow): UserRecord {
  return {
    userUID: row.UserUID,
    orgUID: row.OrgUID,
    name: row.Name,
    email: row.Email,
    password: row.Password,
    role: row.Role,
    createdOn: row.CreatedOn,
    updatedOn: row.UpdatedOn,
  };
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  orgUID: number;
  role?: UserRole;
}

@Injectable()
export class UserRepository {
  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await knexRead<UserTblRow>("UserTbl").where({ Email: email }).first();
    return row ? mapRow(row) : null;
  }

  async findById(userUID: number): Promise<UserRecord | null> {
    const row = await knexRead<UserTblRow>("UserTbl").where({ UserUID: userUID }).first();
    return row ? mapRow(row) : null;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    const [userUID] = await knexWrite<UserTblRow>("UserTbl").insert({
      OrgUID: input.orgUID,
      Name: input.name,
      Email: input.email,
      Password: input.password,
      Role: input.role || "customer",
    });
    const user = await this.findById(userUID);
    if (!user) throw new Error("Failed to load created user");
    return user;
  }
}
