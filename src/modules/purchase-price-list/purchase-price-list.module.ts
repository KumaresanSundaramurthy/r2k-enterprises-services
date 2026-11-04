import { Module } from "@nestjs/common";
import { PurchasePriceListController } from "./purchase-price-list.controller";
import { PurchasePriceListRepository } from "./purchase-price-list.repository";
import { PurchasePriceListService } from "./purchase-price-list.service";

@Module({
  controllers: [PurchasePriceListController],
  providers: [PurchasePriceListService, PurchasePriceListRepository],
})
export class PurchasePriceListModule {}
