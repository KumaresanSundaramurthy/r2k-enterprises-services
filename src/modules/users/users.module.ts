import { Module } from "@nestjs/common";
import { BranchesModule } from "../branches/branches.module";
import { ProfileModule } from "../profile/profile.module";
import { RolesModule } from "../roles/roles.module";
import { SessionSyncModule } from "../session-sync/session-sync.module";
import { UsersController } from "./users.controller";
import { UsersRepository } from "./users.repository";
import { UsersService } from "./users.service";

@Module({
  imports: [ProfileModule, RolesModule, BranchesModule, SessionSyncModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
})
export class UsersModule {}
