import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type Row = Record<string, unknown>;

// One permission row posted from the matrix (MainMenuUID or SubMenuUID with its flags)
export interface PermissionInput {
  MainMenuUID?: number | string;
  SubMenuUID?: number | string;
  CanView?: number | string;
  CanCreate?: number | string;
  CanEdit?: number | string;
  CanDelete?: number | string;
  Sorting?: number | string;
}

const ROLES = "UserRole.RolesTbl";
const flag = (value: unknown) => (Number(value ?? 0) ? 1 : 0);

// CI3 Roles_model.
@Injectable()
export class RolesRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // getRolesList — the organisation's roles and the global ones (first), with how many users have each
  async list(orgUID: number): Promise<Row[]> {
    return this.read(`${ROLES} as R`)
      .select(
        "R.RoleUID", "R.Name", "R.IsDefault", "R.IsGlobal", "R.IsActive", "R.CreatedOn",
        this.read.raw("(SELECT COUNT(*) FROM Users.UserTbl U WHERE U.RoleUID = R.RoleUID AND U.OrgUID = ? AND U.IsDeleted = 0) AS UserCount", [orgUID])
      )
      .where((qb) => qb.where("R.OrgUID", orgUID).orWhere("R.IsGlobal", 1))
      .where("R.IsDeleted", 0)
      .orderBy([
        { column: "R.IsGlobal", order: "desc" },
        { column: "R.RoleUID", order: "asc" },
      ]);
  }

  // Roles_model::getFirstRoleUID — the organisation's oldest role (its admin role); 0 when it has none
  async firstRoleUID(orgUID: number): Promise<number> {
    const row = await this.read(ROLES).select("RoleUID").where({ OrgUID: orgUID, IsDeleted: 0 }).orderBy("RoleUID", "asc").first();
    return row ? Number(row.RoleUID) : 0;
  }

  // A role the organisation can see (its own or a global one)
  async find(orgUID: number, roleUID: number): Promise<Row | null> {
    const row = await this.read(ROLES)
      .select("RoleUID", "Name", "OrgUID", "IsDefault", "IsGlobal")
      .where({ RoleUID: roleUID, IsDeleted: 0 })
      .where((qb) => qb.where("OrgUID", orgUID).orWhere("IsGlobal", 1))
      .first();
    return row ?? null;
  }

  // getAllMenusForMatrix — the organisation's main menus and sub menus
  async menusForMatrix(orgUID: number): Promise<{ main: Row[]; sub: Row[] }> {
    const [main, sub] = await Promise.all([
      this.read("Modules.MainMenusTbl as MM")
        .select("MM.MainMenuUID", "MM.Name", "MM.Icon", "MM.Sorting", this.read.raw("COALESCE(MM.IsDirectLink, 0) AS IsDirectLink"))
        .where({ "MM.OrgUID": orgUID, "MM.IsDeleted": 0, "MM.IsActive": 1 })
        .orderBy("MM.Sorting", "asc"),
      this.read("Modules.SubMenusTbl as SM")
        .select("SM.SubMenuUID", "SM.MainMenuUID", "SM.ParentSubMenuUID", "SM.IsParent", "SM.Name", "SM.UrlPath as ControllerName", "SM.Icon", "SM.Sorting")
        .where({ "SM.OrgUID": orgUID, "SM.IsDeleted": 0, "SM.IsActive": 1 })
        .orderBy([
          { column: "SM.MainMenuUID", order: "asc" },
          { column: "SM.Sorting", order: "asc" },
        ]),
    ]);
    return { main, sub };
  }

  // getRolePermissions
  async permissions(roleUID: number): Promise<{ main: Row[]; sub: Row[] }> {
    const [main, sub] = await Promise.all([
      this.read("UserRole.RoleMainMenusTbl")
        .select("RoleMainMenuUID", "MainMenuUID", "CanView", "CanCreate", "CanEdit", "CanDelete")
        .where({ RoleUID: roleUID, IsDeleted: 0 }),
      this.read("UserRole.RoleSubMenusTbl")
        .select("RoleSubMenuUID", "SubMenuUID", "CanView", "CanCreate", "CanEdit", "CanDelete")
        .where({ RoleUID: roleUID, IsDeleted: 0 }),
    ]);
    return { main, sub };
  }

  // isRoleInUse
  async inUse(roleUID: number): Promise<boolean> {
    return !!(await this.read("Users.UserTbl").select("UserUID").where({ RoleUID: roleUID, IsDeleted: 0 }).first());
  }

  async insert(data: Row, trx: Knex.Transaction): Promise<number> {
    const [id] = await trx(ROLES).insert(data);
    return Number(id);
  }

  async update(orgUID: number, roleUID: number, data: Row, trx?: Knex.Transaction): Promise<void> {
    await this.writer(trx)(ROLES).where({ RoleUID: roleUID, OrgUID: orgUID }).update(data);
  }

  // saveRolePermissions — bulk upserts; sub menus are linked to the role's row for their main menu
  async savePermissions(trx: Knex.Transaction, roleUID: number, mainMenus: PermissionInput[], subMenus: PermissionInput[], userUID: number): Promise<void> {
    const now = trx.fn.now();
    const audit = { IsActive: 1, IsDeleted: 0, UpdatedBy: userUID, UpdatedOn: now, CreatedBy: userUID, CreatedOn: now };

    const mainRows = mainMenus
      .filter((menu) => Number(menu.MainMenuUID) > 0)
      .map((menu) => ({ RoleUID: roleUID, MainMenuUID: Number(menu.MainMenuUID), ...RolesRepository.flags(menu), ...audit }));
    if (mainRows.length > 0) {
      await trx("UserRole.RoleMainMenusTbl")
        .insert(mainRows)
        .onConflict()
        .merge({
          CanView: trx.raw("VALUES(CanView)"),
          CanCreate: trx.raw("VALUES(CanCreate)"),
          CanEdit: trx.raw("VALUES(CanEdit)"),
          CanDelete: trx.raw("VALUES(CanDelete)"),
          Sorting: trx.raw("VALUES(Sorting)"),
          IsActive: 1,
          IsDeleted: 0,
          UpdatedBy: trx.raw("VALUES(UpdatedBy)"),
          UpdatedOn: trx.raw("VALUES(UpdatedOn)"),
        });
    }

    const subUIDs = subMenus.map((menu) => Number(menu.SubMenuUID)).filter((uid) => uid > 0);
    if (subUIDs.length === 0) return;
    const links: Row[] = await trx("UserRole.RoleMainMenusTbl as RMM")
      .select("SM.SubMenuUID", "RMM.RoleMainMenuUID")
      .join("Modules.SubMenusTbl as SM", "SM.MainMenuUID", "RMM.MainMenuUID")
      .where("RMM.RoleUID", roleUID)
      .whereIn("SM.SubMenuUID", subUIDs);
    const roleMainMenu = new Map(links.map((link) => [Number(link.SubMenuUID), Number(link.RoleMainMenuUID)]));

    const subRows = subMenus
      .filter((menu) => Number(menu.SubMenuUID) > 0)
      .map((menu) => ({
        RoleUID: roleUID,
        RoleMainMenuUID: roleMainMenu.get(Number(menu.SubMenuUID)) ?? 0,
        SubMenuUID: Number(menu.SubMenuUID),
        ...RolesRepository.flags(menu),
        ...audit,
      }));
    await trx("UserRole.RoleSubMenusTbl")
      .insert(subRows)
      .onConflict()
      .merge({
        RoleMainMenuUID: trx.raw("VALUES(RoleMainMenuUID)"),
        CanView: trx.raw("VALUES(CanView)"),
        CanCreate: trx.raw("VALUES(CanCreate)"),
        CanEdit: trx.raw("VALUES(CanEdit)"),
        CanDelete: trx.raw("VALUES(CanDelete)"),
        Sorting: trx.raw("VALUES(Sorting)"),
        IsActive: 1,
        IsDeleted: 0,
        UpdatedBy: trx.raw("VALUES(UpdatedBy)"),
        UpdatedOn: trx.raw("VALUES(UpdatedOn)"),
      });
  }

  private static flags(menu: PermissionInput) {
    return {
      CanView: flag(menu.CanView),
      CanCreate: flag(menu.CanCreate),
      CanEdit: flag(menu.CanEdit),
      CanDelete: flag(menu.CanDelete),
      Sorting: Number(menu.Sorting ?? 0) || 0,
    };
  }
}
