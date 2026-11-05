import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { SessionSyncModule } from "../session-sync/session-sync.module";
import { AdditionalChargesRepository, AdditionalChargesService } from "./additional-charges.service";
import { BankAccountsRepository } from "./bank-accounts.repository";
import { BankAccountsService } from "./bank-accounts.service";
import { GeneralSettingsService } from "./general-settings.service";
import { PrintConfigRepository } from "./print-config.repository";
import { PrintConfigService } from "./print-config.service";
import {
  AdditionalChargesController,
  BankAccountsController,
  GeneralSettingsController,
  MessageTemplatesController,
  PrefixConfigController,
  ThermalConfigController,
} from "./settings.controller";
import { SettingsLookupsRepository } from "./settings-lookups.repository";

@Module({
  // AuthModule: the session's settings loaders; SessionSyncModule: writing them back into the session
  imports: [AuthModule, SessionSyncModule],
  controllers: [
    GeneralSettingsController,
    BankAccountsController,
    MessageTemplatesController,
    ThermalConfigController,
    PrefixConfigController,
    AdditionalChargesController,
  ],
  providers: [
    GeneralSettingsService,
    BankAccountsService,
    BankAccountsRepository,
    PrintConfigService,
    PrintConfigRepository,
    AdditionalChargesService,
    AdditionalChargesRepository,
    SettingsLookupsRepository,
  ],
  exports: [SettingsLookupsRepository, AdditionalChargesRepository],
})
export class SettingsModule {}
