import { Module } from "@nestjs/common";
import { CustomerAccountService } from "./customer-account.service";
import { CustomerAttachmentService } from "./customer-attachment.service";
import { CustomerProfileRepository } from "./customer-profile.repository";
import { CustomerProfileService } from "./customer-profile.service";
import { CustomerCacheService } from "./customer-cache.service";
import { CustomerExportService } from "./customer-export.service";
import { CustomerGroupWriteService } from "./customer-group-write.service";
import { CustomerGroupsController } from "./customer-groups.controller";
import { CustomerGroupsRepository } from "./customer-groups.repository";
import { CustomerGroupsService } from "./customer-groups.service";
import { CustomerTranslationService } from "./customer-translation.service";
import { CustomerWriteService } from "./customer-write.service";
import { CustomersController } from "./customers.controller";
import { CustomersRepository } from "./customers.repository";
import { CustomersService } from "./customers.service";

@Module({
  controllers: [CustomersController, CustomerGroupsController],
  providers: [
    CustomersService,
    CustomerWriteService,
    CustomerAccountService,
    CustomerProfileService,
    CustomerProfileRepository,
    CustomerCacheService,
    CustomerExportService,
    CustomerAttachmentService,
    CustomerTranslationService,
    CustomersRepository,
    CustomerGroupsService,
    CustomerGroupWriteService,
    CustomerGroupsRepository,
  ],
  exports: [CustomersRepository, CustomerGroupsRepository, CustomerCacheService],
})
export class CustomersModule {}
