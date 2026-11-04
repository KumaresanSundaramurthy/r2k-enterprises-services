import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, StreamableFile, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiProduces, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { ExportResult } from "../../libraries/export/export.service";
import { AcceptForm } from "../products/product-files";
import {
  AdjustmentDto,
  InventoryExportDto,
  InventoryListDto,
  LedgerRemarksDto,
  ProductIdQueryDto,
  ProductSearchDto,
  SerialAddDto,
  SerialListDto,
  SerialProductSearchDto,
  SerialStatusDto,
  StockAdjustDto,
  TimelineListDto,
} from "./inventory.dto";
import { InventoryService } from "./inventory.service";
import { SerialsService } from "./serials.service";
import { StockTimelineService } from "./stock-timeline.service";

// 1-based page from the path, else from PageNo (0 or invalid = 1)
const pageOf = (pathPage: string | undefined, dto: { PageNo?: string | number }) => Math.max(1, Number(pathPage ?? dto.PageNo) || 1);

// Export filter: JSON in the query string, as the CI3 JS sends it
function exportFilter(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// CSV / Excel are sent as a download; Pdf / Print come back as HtmlData to print
function sendExport(result: ExportResult, res: Response) {
  if (result.kind === "html") return ciSuccess({ HtmlData: result.html });
  res.set({
    "Content-Type": result.contentType,
    "Content-Disposition": `attachment; filename="${result.fileName}"`,
    "Access-Control-Expose-Headers": "Content-Disposition",
    Pragma: "no-cache",
  });
  return new StreamableFile(result.body);
}

/**
 * Inventory page of CI3 (Inventory controller), same paths as its JS calls. List rows are returned as data
 * (CI3 rendered them as HTML). Endpoints the CI3 JS does not call are migrated but hidden from Swagger.
 */
@ApiTags("Inventory")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/inventory")
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "Page data: Stats, Categories, OrgUsers, ShowUserFilter, RowLimit" })
  async getPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.inventory.getPageData(dto.orgId));
  }

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: "Stock list page (Data, TotalCount, PageNo, RowLimit); quantity is the stock ledger total" })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: InventoryListDto) {
    return ciSuccess(await this.inventory.getPage(dto.orgId, pageOf(pageNo, dto), dto.RowLimit, dto.Filter ?? {}));
  }

  @Get("getStats")
  @ApiOperation({ summary: "Stat cards (Stats: positiveCount / Qty, lowStockCount / Qty, saleValue, purchaseValue)" })
  async getStats(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.inventory.getStats(dto.orgId));
  }

  @Post("stockIn")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add stock to a product (manual adjustment with its journal); returns the refreshed Stats" })
  async stockIn(@Body() dto: StockAdjustDto, @Req() req: Request) {
    return ciSuccess(await this.inventory.adjust(writeContext(dto, req), { ...dto }, "IN"));
  }

  @Post("stockOut")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Remove stock from a product (manual adjustment with its journal); returns the refreshed Stats" })
  async stockOut(@Body() dto: StockAdjustDto, @Req() req: Request) {
    return ciSuccess(await this.inventory.adjust(writeContext(dto, req), { ...dto }, "OUT"));
  }

  @Get("getTimeline")
  @ApiOperation({ summary: "A product's last 200 stock movements (Timeline)" })
  async getTimeline(@Query() dto: ProductIdQueryDto) {
    return ciSuccess(await this.inventory.getProductTimeline(dto.orgId, postInt(dto, "ProductUID")));
  }

  @Get("getVariantStock")
  @ApiOperation({ summary: "Stock per brand / size variant of a product (Variants)" })
  async getVariantStock(@Query() dto: ProductIdQueryDto) {
    return ciSuccess(await this.inventory.getVariantStock(dto.orgId, postInt(dto, "ProductUID")));
  }

  @Get("searchProducts")
  @ApiOperation({ summary: "Stock products by name for the item filter, 50 at most (Products)" })
  async searchProducts(@Query() dto: ProductSearchDto) {
    return ciSuccess(await this.inventory.searchProducts(dto.orgId, String(dto.Term ?? ""), dto.langCode));
  }

  @Post("updateLedgerRemarks")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Set the remarks of a stock movement" })
  async updateLedgerRemarks(@Body() dto: LedgerRemarksDto, @Req() req: Request) {
    return ciSuccess(await this.inventory.updateLedgerRemarks(writeContext(dto, req), { ...dto }));
  }

  @Get("export")
  @ApiProduces("text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/json")
  @ApiOperation({ summary: "Export the filtered stock list: CSV / Excel file, or HtmlData to print (Pdf / Print)" })
  async export(@Query() dto: InventoryExportDto, @Res({ passthrough: true }) res: Response) {
    return sendExport(await this.inventory.export(dto.orgId, dto.Type, exportFilter(dto.Filter)), res);
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("updateAdj")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async updateAdj(@Body() dto: AdjustmentDto, @Req() req: Request) {
    return ciSuccess(await this.inventory.updateAdjustment(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteAdj")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async deleteAdj(@Body() dto: AdjustmentDto, @Req() req: Request) {
    return ciSuccess(await this.inventory.deleteAdjustment(writeContext(dto, req), { ...dto }));
  }
}

/** Inventory → Timeline page of CI3 (Inventory::timelinePage / getTimelinePageDetails / exportTimeline). */
@ApiTags("Inventory Timeline")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/inventory")
export class InventoryTimelineController {
  constructor(private readonly timeline: StockTimelineService) {}

  @Get("timeline/getPageData")
  @ApiOperation({ summary: "Page data: Categories, RowLimit and the saved date range (DefaultFilter, SavedDate*)" })
  async getPageData(@Query() dto: OrgUserBranchContextDto) {
    return ciSuccess(await this.timeline.getPageData(dto.orgId, dto.branchId, dto.userId));
  }

  @Get(["timeline/getPageDetails", "timeline/getPageDetails/:pageNo"])
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: "Stock movements of every product, newest first (Data, TotalCount, PageNo, RowLimit)" })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: TimelineListDto) {
    return ciSuccess(await this.timeline.getPage(dto.orgId, pageOf(pageNo, dto), dto.RowLimit, dto.Filter ?? {}));
  }

  @Get("exportTimeline")
  @ApiProduces("text/csv", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/json")
  @ApiOperation({ summary: "Export the filtered movements: CSV / Excel file, or HtmlData to print (Pdf / Print)" })
  async exportTimeline(@Query() dto: InventoryExportDto, @Res({ passthrough: true }) res: Response) {
    return sendExport(await this.timeline.export(dto.orgId, dto.Type, exportFilter(dto.Filter)), res);
  }
}

/** Inventory → Serial Numbers page of CI3 (Inventory serial actions). */
@ApiTags("Serial Numbers")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/inventory")
export class InventorySerialsController {
  constructor(private readonly serials: SerialsService) {}

  @Get("serials/getPageData")
  @ApiOperation({ summary: "Page data: ShowStats, Stats (per status and total), Statuses, RowLimit" })
  async getPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.serials.getPageData(dto.orgId));
  }

  @Get(["serials/getPageDetails", "serials/getPageDetails/:pageNo"])
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: "Serial list page, newest first (Data, TotalCount, PageNo, RowLimit, Stats)" })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: SerialListDto) {
    return ciSuccess(await this.serials.getPage(dto.orgId, pageOf(pageNo, dto), dto.RowLimit, dto.Filter ?? {}));
  }

  @Get("serials/searchProducts")
  @ApiOperation({ summary: "Serial-tracked products by name, 50 at most (Data)" })
  async searchProducts(@Query() dto: SerialProductSearchDto) {
    return ciSuccess(await this.serials.searchProducts(dto.orgId, String(dto.search ?? "")));
  }

  @Post("serials/add")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add a serial number to a product (unique per product)" })
  async add(@Body() dto: SerialAddDto, @Req() req: Request) {
    return ciSuccess(await this.serials.add(writeContext(dto, req), { ...dto }));
  }

  @Post("serials/updateStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Mark a serial Damaged or Available" })
  async updateStatus(@Body() dto: SerialStatusDto, @Req() req: Request) {
    return ciSuccess(await this.serials.updateStatus(writeContext(dto, req), { ...dto }));
  }
}
