import { Module } from "@nestjs/common";
import { DriveController } from "./drive.controller";
import { DriveRepository } from "./drive.repository";
import { DriveService } from "./drive.service";

@Module({
  controllers: [DriveController],
  providers: [DriveService, DriveRepository],
})
export class DriveModule {}
