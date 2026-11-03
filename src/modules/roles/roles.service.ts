import { Injectable } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postJsonArray } from "../../core/utils/form-values";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { SessionSyncService } from "../session-sync/session-sync.service";
import { PermissionInput, RolesRepository } from "./roles.repository";

type Form = Record<string, unknown>;

// Settings → Roles (CI3 Roles controller): roles and their menu permissions.
@Injectable()
export class RolesService {
  constructor(
    private readonly repo: RolesRepository,
    private readonly db: DatabaseService,
    private readonly orgSettings: OrgSettingsService,
    private readonly redis: RedisService,
    private readonly orgInfoCache: OrgInfoCacheService,
    private readonly sessionSync: SessionSyncService
  ) {}

  // index — roles plus every menu and sub menu for the permission matrix
  async getPageData(orgUID: number) {
    const [roles, menus] = await Promise.all([this.repo.list(orgUID), this.repo.menusForMatrix(orgUID)]);
    return { RolesList: roles, AllMainMenus: menus.main, AllSubMenus: menus.sub };
  }

  // getRolesList
  async getList(orgUID: number) {
    return { Data: await this.repo.list(orgUID) };
  }

  // getRolePermissions — of a role this organisation can see
  async getPermissions(orgUID: number, roleUID: number) {
    if (!roleUID) throw new CiValidationError("RoleUID is required.");
    if (!(await this.repo.find(orgUID, roleUID))) throw new CiValidationError("Role not found.");
    return { Data: await this.repo.permissions(roleUID) };
  }

  // saveRole — create or rename (not a global or default role), with permissions when they are posted
  async save(form: Form, ctx: WriteContext, branchUID: number | null) {
    const { orgUID, userUID } = ctx;
    let roleUID = postInt(form, "RoleUID");
    const isUpdate = roleUID > 0;
    const name = String(form.RoleName ?? "").trim();
    if (!name) throw new CiValidationError("Role name is required.");
    if (isUpdate) {
      const role = await this.repo.find(orgUID, roleUID);
      if (!role) throw new CiValidationError("Role not found.");
      if (Number(role.IsGlobal)) throw new CiValidationError("Global roles cannot be modified.");
      if (Number(role.IsDefault)) throw new CiValidationError("Default roles cannot be renamed.");
    }

    const { mainMenus, subMenus } = RolesService.postedPermissions(form);
    const data = { Name: name, OrgUID: orgUID, BranchUID: branchUID, IsActive: 1, IsDeleted: 0 };
    await this.db.write.transaction(async (trx) => {
      if (isUpdate) await this.repo.update(orgUID, roleUID, { ...data, UpdatedBy: userUID }, trx);
      // UpdatedBy has no default in RolesTbl (CI3's insert leaves it out and fails)
      else roleUID = await this.repo.insert({ ...data, CreatedBy: userUID, UpdatedBy: userUID }, trx);
      if (mainMenus.length > 0 || subMenus.length > 0) await this.repo.savePermissions(trx, roleUID, mainMenus, subMenus, userUID);
    });
    await this.clearRoleMenuCaches(orgUID, roleUID);
    return { Message: isUpdate ? "Role updated successfully." : "Role created successfully.", UID: roleUID };
  }

  // saveRolePermissions — then the logged-in user's session and the org-info cache are rebuilt
  async savePermissions(form: Form, ctx: WriteContext, sessionKey: string | undefined) {
    const roleUID = postInt(form, "RoleUID");
    if (!roleUID) throw new CiValidationError("RoleUID is required.");
    if (!(await this.repo.find(ctx.orgUID, roleUID))) throw new CiValidationError("Role not found.");

    const { mainMenus, subMenus } = RolesService.postedPermissions(form);
    await this.db.write.transaction((trx) => this.repo.savePermissions(trx, roleUID, mainMenus, subMenus, ctx.userUID));
    await this.clearRoleMenuCaches(ctx.orgUID, roleUID);
    await this.sessionSync.refresh(sessionKey);
    await this.orgInfoCache.refresh(ctx.orgUID);
    return { Message: "Permissions saved successfully." };
  }

  // deleteRole — not a global, default or assigned role
  async delete(roleUID: number, ctx: WriteContext) {
    if (!roleUID) throw new CiValidationError("RoleUID is required.");
    const role = await this.repo.find(ctx.orgUID, roleUID);
    if (!role) throw new CiValidationError("Role not found.");
    if (Number(role.IsGlobal)) throw new CiValidationError("Global roles cannot be deleted.");
    if (Number(role.IsDefault)) throw new CiValidationError("Default roles cannot be deleted.");
    if (await this.repo.inUse(roleUID)) throw new CiValidationError("This role is assigned to one or more users. Reassign them first.");
    await this.repo.update(ctx.orgUID, roleUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    return { Message: "Role deleted successfully." };
  }

  // The role's menu caches, so its users get the new permissions on their next login / refresh
  private async clearRoleMenuCaches(orgUID: number, roleUID: number): Promise<void> {
    const orgToken = (await this.orgSettings.get(orgUID)).OrgToken;
    await this.redis.del(this.redis.orgKey(`role-menus-${roleUID}`, orgToken), this.redis.orgKey(`role-submenus-${roleUID}`, orgToken));
  }

  // MainMenus / SubMenus — posted as arrays or as JSON strings
  private static postedPermissions(form: Form) {
    return { mainMenus: postJsonArray<PermissionInput>(form, "MainMenus"), subMenus: postJsonArray<PermissionInput>(form, "SubMenus") };
  }
}
