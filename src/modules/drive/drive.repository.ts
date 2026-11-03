import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

const ITEMS = "Drive.DriveItemsTbl";
// Breadcrumbs stop after this many levels (CI3 getFolderPath)
const MAX_DEPTH = 20;

// CI3 Drive_model: one user's files and folders inside the organisation.
@Injectable()
export class DriveRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getItems — folders before files, by name
  async items(orgUID: number, userUID: number, parentUID: number): Promise<Row[]> {
    return this.read(ITEMS)
      .select("DriveItemUID", "UserUID", "ParentUID", "ItemType", "ItemName", "FilePath", "FileSize", "MimeType", "CreatedOn")
      .where({ OrgUID: orgUID, UserUID: userUID, ParentUID: parentUID, IsDeleted: 0 })
      .orderBy([
        { column: "ItemType", order: "asc" },
        { column: "ItemName", order: "asc" },
      ]);
  }

  // getUserUsage — bytes of the user's files
  async usage(orgUID: number, userUID: number): Promise<number> {
    const row = await this.read(ITEMS).sum({ used: "FileSize" }).where({ OrgUID: orgUID, UserUID: userUID, ItemType: "File", IsDeleted: 0 }).first();
    return Number(row?.used ?? 0);
  }

  // getFolderPath — root → folder
  async path(orgUID: number, folderUID: number): Promise<{ DriveItemUID: number; ItemName: string }[]> {
    const path: { DriveItemUID: number; ItemName: string }[] = [];
    let uid = folderUID;
    for (let depth = 0; uid > 0 && depth < MAX_DEPTH; depth++) {
      const row = await this.read(ITEMS).select("DriveItemUID", "ItemName", "ParentUID").where({ DriveItemUID: uid, OrgUID: orgUID, IsDeleted: 0 }).first();
      if (!row) break;
      path.unshift({ DriveItemUID: Number(row.DriveItemUID), ItemName: row.ItemName });
      uid = Number(row.ParentUID);
    }
    return path;
  }

  async find(orgUID: number, itemUID: number): Promise<Row | null> {
    const row = await this.read(ITEMS).select("*").where({ DriveItemUID: itemUID, OrgUID: orgUID, IsDeleted: 0 }).first();
    return row ?? null;
  }

  // isDuplicateName — names are unique per folder, ignoring case
  async nameTaken(orgUID: number, userUID: number, parentUID: number, name: string, excludeUID = 0): Promise<boolean> {
    const qb = this.read(ITEMS)
      .select("DriveItemUID")
      .where({ OrgUID: orgUID, UserUID: userUID, ParentUID: parentUID, IsDeleted: 0 })
      .whereRaw("LOWER(ItemName) = ?", [name.toLowerCase()]);
    if (excludeUID > 0) qb.whereNot("DriveItemUID", excludeUID);
    return !!(await qb.first());
  }

  async insert(data: Row): Promise<number> {
    const [id] = await this.db.write(ITEMS).insert({ IsDeleted: 0, ...data });
    return Number(id);
  }

  async update(orgUID: number, userUID: number, itemUID: number, data: Row): Promise<void> {
    await this.db.write(ITEMS).where({ DriveItemUID: itemUID, OrgUID: orgUID, UserUID: userUID }).update(data);
  }

  // softDeleteItem — the item and everything inside it
  async softDelete(orgUID: number, userUID: number, itemUID: number, actorUID: number): Promise<void> {
    await this.update(orgUID, userUID, itemUID, { IsDeleted: 1, UpdatedBy: actorUID });
    const children: Row[] = await this.read(ITEMS).select("DriveItemUID", "ItemType").where({ ParentUID: itemUID, OrgUID: orgUID, UserUID: userUID, IsDeleted: 0 });
    for (const child of children) {
      if (child.ItemType === "Folder") await this.softDelete(orgUID, userUID, Number(child.DriveItemUID), actorUID);
      else await this.update(orgUID, userUID, Number(child.DriveItemUID), { IsDeleted: 1, UpdatedBy: actorUID });
    }
  }

  // getOrgUsers — whose drive a Super Admin can open
  async loginUsers(orgUID: number): Promise<Row[]> {
    return this.read("Users.UserTbl")
      .select("UserUID", this.read.raw("CONCAT(FirstName, ' ', LastName) AS FullName"))
      .where({ OrgUID: orgUID, IsDeleted: 0, IsActive: 1, HasLoginAccess: 1 })
      .orderBy("FirstName", "asc");
  }
}
