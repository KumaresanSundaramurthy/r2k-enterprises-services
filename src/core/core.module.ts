import { Global, Module } from "@nestjs/common";
import { BackgroundTaskService } from "./background/background-task.service";
import { DatabaseService } from "./database/database.service";
import { OrgSettingsService } from "./org/org-settings.service";

// Foundation shared by every feature module.
@Global()
@Module({
  providers: [DatabaseService, OrgSettingsService, BackgroundTaskService],
  exports: [DatabaseService, OrgSettingsService, BackgroundTaskService],
})
export class CoreModule {}
