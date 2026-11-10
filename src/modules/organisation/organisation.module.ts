import { Module } from "@nestjs/common";
import { OrganisationWriteService } from "./organisation-write.service";
import { OrganisationController, OrganisationPublicController } from "./organisation.controller";
import { OrganisationRepository } from "./organisation.repository";
import { OrganisationService } from "./organisation.service";

@Module({
  controllers: [OrganisationPublicController, OrganisationController],
  providers: [OrganisationService, OrganisationWriteService, OrganisationRepository],
})
export class OrganisationModule {}
