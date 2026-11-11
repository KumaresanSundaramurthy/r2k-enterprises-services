import { Module } from "@nestjs/common";
import { VendorAccountService } from "./vendor-account.service";
import { VendorAttachmentService } from "./vendor-attachment.service";
import { VendorBalanceController } from "./vendor-balance.controller";
import { VendorCacheService } from "./vendor-cache.service";
import { VendorExportService } from "./vendor-export.service";
import { VendorGroupWriteService } from "./vendor-group-write.service";
import { VendorGroupsController } from "./vendor-groups.controller";
import { VendorGroupsRepository } from "./vendor-groups.repository";
import { VendorGroupsService } from "./vendor-groups.service";
import { VendorProfileRepository } from "./vendor-profile.repository";
import { VendorProfileService } from "./vendor-profile.service";
import { VendorTranslationService } from "./vendor-translation.service";
import { VendorWriteService } from "./vendor-write.service";
import { VendorsController } from "./vendors.controller";
import { VendorsRepository } from "./vendors.repository";
import { VendorsService } from "./vendors.service";

@Module({
  controllers: [VendorsController, VendorGroupsController, VendorBalanceController],
  providers: [
    VendorsService,
    VendorWriteService,
    VendorAccountService,
    VendorProfileService,
    VendorProfileRepository,
    VendorCacheService,
    VendorExportService,
    VendorAttachmentService,
    VendorTranslationService,
    VendorsRepository,
    VendorGroupsService,
    VendorGroupWriteService,
    VendorGroupsRepository,
  ],
  exports: [VendorsRepository, VendorGroupsRepository, VendorCacheService],
})
export class VendorsModule {}
