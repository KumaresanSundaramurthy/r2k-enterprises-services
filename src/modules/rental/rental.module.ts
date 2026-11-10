import { Module } from "@nestjs/common";
import { RentalController } from "./rental.controller";
import { RentalRepository } from "./rental.repository";
import { RentalService } from "./rental.service";

@Module({
  controllers: [RentalController],
  providers: [RentalService, RentalRepository],
})
export class RentalModule {}
