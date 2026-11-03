import { Module } from "@nestjs/common";
import { SettingsModule } from "../settings/settings.module";
import { PrintThemesController } from "./print-themes.controller";
import { PrintThemesRepository } from "./print-themes.repository";
import { PrintThemesService } from "./print-themes.service";

@Module({
  // SettingsModule: the module lists (which modules print)
  imports: [SettingsModule],
  controllers: [PrintThemesController],
  providers: [PrintThemesService, PrintThemesRepository],
})
export class PrintThemesModule {}
