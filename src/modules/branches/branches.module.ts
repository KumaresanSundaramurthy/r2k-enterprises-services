import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { BranchesController, BranchSessionController } from "./branches.controller";
import { BranchesRepository } from "./branches.repository";
import { BranchesService } from "./branches.service";

@Module({
  // AuthModule provides the session guard used by switchBranch
  imports: [AuthModule],
  controllers: [BranchesController, BranchSessionController],
  providers: [BranchesService, BranchesRepository],
  exports: [BranchesRepository],
})
export class BranchesModule {}
