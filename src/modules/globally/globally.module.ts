import { Module } from "@nestjs/common";
import { GloballyController } from "./globally.controller";
import { GloballyRepository } from "./globally.repository";
import { GloballyService } from "./globally.service";

@Module({
  controllers: [GloballyController],
  providers: [GloballyService, GloballyRepository],
})
export class GloballyModule {}
