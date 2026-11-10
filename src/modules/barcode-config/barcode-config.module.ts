import { Module } from "@nestjs/common";
import { BarcodeConfigController } from "./barcode-config.controller";
import { BarcodeConfigRepository } from "./barcode-config.repository";
import { BarcodeConfigService } from "./barcode-config.service";

@Module({
  controllers: [BarcodeConfigController],
  providers: [BarcodeConfigService, BarcodeConfigRepository],
})
export class BarcodeConfigModule {}
