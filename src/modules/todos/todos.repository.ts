import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

type Row = Record<string, unknown>;

/** Todos (CI3 Todo_model): task records linked to org entities. */
@Injectable()
export class TodosRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  async getById(orgUID: number, todoUID: number): Promise<Row | null> {
    const row = await this.read("Task.TodoTbl as t")
      .select("t.*", this.read.raw("CONCAT(a.FirstName, ' ', a.LastName) AS ??", ["AssignedName"]), this.read.raw("CONCAT(c.FirstName, ' ', c.LastName) AS ??", ["CreatedByName"]))
      .leftJoin("Users.UserTbl as a", function () {
        this.on("a.UserUID", "t.AssignedToUID").andOnVal("a.IsDeleted", 0);
      })
      .leftJoin("Users.UserTbl as c", function () {
        this.on("c.UserUID", "t.CreatedByUID").andOnVal("c.IsDeleted", 0);
      })
      .where({ "t.TodoUID": todoUID, "t.OrgUID": orgUID, "t.IsDeleted": 0 })
      .first();
    return (row as Row | undefined) ?? null;
  }

  async getPendingBadgeCount(orgUID: number, userUID: number): Promise<number> {
    const row = await this.read("Task.TodoTbl")
      .count("* as cnt")
      .where({ OrgUID: orgUID, IsDeleted: 0 })
      .whereIn("Status", ["Open", "InProgress", "OnHold"])
      .where(function () {
        this.where("AssignedToUID", userUID).orWhere("CreatedByUID", userUID);
      })
      .first();
    return Number((row as Row | undefined)?.cnt ?? 0);
  }

  getLinkedTodos(orgUID: number, refType: string, refUID: number): Promise<Row[]> {
    return this.read("Task.TodoTbl as t")
      .select("t.TodoUID", "t.Title", "t.Priority", "t.Status", "t.DueDate", this.read.raw("CONCAT(a.FirstName, ' ', a.LastName) AS ??", ["AssignedName"]))
      .leftJoin("Users.UserTbl as a", function () {
        this.on("a.UserUID", "t.AssignedToUID").andOnVal("a.IsDeleted", 0);
      })
      .where({ "t.OrgUID": orgUID, "t.IsDeleted": 0, "t.RefType": refType, "t.RefUID": refUID })
      .orderBy("t.TodoUID", "desc");
  }
}
