import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service";

// Roles CI3 treats specially (UserRole.RolesTbl): 1 = Super Admin, 2 = Admin
const SUPER_ADMIN_ROLE = 1;
const SALARY_ROLES = [1, 2];

/**
 * Who the caller is, for the checks CI3 makes on JwtData->User->RoleUID. This API is stateless, so the role is
 * read from the database for the userId the caller sends.
 */
@Injectable()
export class UserAccessService {
  constructor(private readonly db: DatabaseService) {}

  async roleUID(orgUID: number, userUID: number): Promise<number> {
    const row = await this.db.read("Users.UserTbl").select("RoleUID").where({ UserUID: userUID, OrgUID: orgUID, IsDeleted: 0 }).first();
    return Number(row?.RoleUID ?? 0);
  }

  // Drive::_isSuperAdmin
  async isSuperAdmin(orgUID: number, userUID: number): Promise<boolean> {
    return (await this.roleUID(orgUID, userUID)) === SUPER_ADMIN_ROLE;
  }

  // Users::_canSeeSalary — Super Admin and Admin
  async canSeeSalary(orgUID: number, userUID: number): Promise<boolean> {
    return SALARY_ROLES.includes(await this.roleUID(orgUID, userUID));
  }
}
