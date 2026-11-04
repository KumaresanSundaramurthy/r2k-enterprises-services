import { Module } from "@nestjs/common";
import { ProductMasterModule } from "../products/product-master.module";
import { InventoryController, InventorySerialsController, InventoryTimelineController } from "./inventory.controller";
import { InventoryRepository } from "./inventory.repository";
import { InventoryService } from "./inventory.service";
import { SerialsRepository } from "./serials.repository";
import { SerialsService } from "./serials.service";
import { StockTimelineRepository } from "./stock-timeline.repository";
import { StockTimelineService } from "./stock-timeline.service";

// Inventory, its Timeline and Serial Numbers pages (CI3 Inventory controller)
@Module({
  imports: [ProductMasterModule],
  controllers: [InventoryController, InventoryTimelineController, InventorySerialsController],
  providers: [InventoryService, InventoryRepository, StockTimelineService, StockTimelineRepository, SerialsService, SerialsRepository],
})
export class InventoryModule {}
