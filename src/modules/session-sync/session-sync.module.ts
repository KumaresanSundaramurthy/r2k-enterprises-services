import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { SessionSyncService } from "./session-sync.service";

// Updates to the logged-in session for modules whose changes CI3 writes back into it
@Module({
  imports: [AuthModule],
  providers: [SessionSyncService],
  exports: [SessionSyncService],
})
export class SessionSyncModule {}
