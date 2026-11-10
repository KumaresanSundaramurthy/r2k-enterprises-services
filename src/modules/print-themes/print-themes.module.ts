import { Module } from "@nestjs/common";
import { SettingsModule } from "../settings/settings.module";
import { PrintThemesController, PrintThemesPublicController } from "./print-themes.controller";
import { PrintThemesRepository } from "./print-themes.repository";
import { PrintThemesService } from "./print-themes.service";

@Module({
  // SettingsModule: the module lists (which modules print)
  imports: [SettingsModule],
  controllers: [PrintThemesPublicController, PrintThemesController],
  providers: [PrintThemesService, PrintThemesRepository],
})
export class PrintThemesModule {}
