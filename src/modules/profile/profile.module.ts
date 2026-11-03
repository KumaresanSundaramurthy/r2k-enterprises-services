import { Module } from "@nestjs/common";
import { SessionSyncModule } from "../session-sync/session-sync.module";
import { ProfileController, ProfileRecordsController, ProfileSignaturesController } from "./profile.controller";
import { ProfileRecordsService } from "./profile-records.service";
import { ProfileSessionService } from "./profile-session.service";
import { ProfileSignatureService } from "./profile-signature.service";
import { ProfileRepository } from "./profile.repository";
import { ProfileService } from "./profile.service";

@Module({
  imports: [SessionSyncModule],
  controllers: [ProfileController, ProfileSignaturesController, ProfileRecordsController],
  providers: [ProfileService, ProfileSignatureService, ProfileRecordsService, ProfileSessionService, ProfileRepository],
  // Manage Users shows and edits other users with the same queries and attachment handling
  exports: [ProfileService, ProfileRepository],
})
export class ProfileModule {}
