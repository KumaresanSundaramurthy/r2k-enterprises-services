import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { CiValidationError, ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { BomSearchDto, DropdownCacheDto, ProductListDto } from "./dto/product-list.dto";
import {
  ComboFormDto,
  ComboIdDto,
  ComboQueryDto,
  EntityAttachmentDeleteDto,
  EntityAttachmentsDto,
  EntityAttachmentsSaveDto,
  ItemQueryDto,
  ProductBulkDeleteDto,
  ProductFormDto,
  ProductIdDto,
  ProductQueryDto,
  ProductStatusDto,
  RecalcStockDto,
} from "./dto/product-write.dto";
import { ProductAttachmentService } from "./product-attachment.service";
import { ProductCacheService } from "./product-cache.service";
import { AcceptFiles, AcceptForm, FileFields, filesOf } from "./product-files";
import { ProductItemsService } from "./product-items.service";
import { ProductProfileService } from "./product-profile.service";
import { ProductWriteService } from "./product-write.service";

/**
 * Items and combos of the CI3 Products page; routes keep CI3's method names (/products/... → /api/products/...).
 * Endpoints the CI3 JS calls are listed in Swagger; the other CI3 functions are migrated too but hidden.
 */
@ApiTags("Product Items")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/products")
export class ProductItemsController {
  constructor(
    private readonly items: ProductItemsService,
    private readonly writes: ProductWriteService,
    private readonly profile: ProductProfileService,
    private readonly cache: ProductCacheService,
    private readonly attachments: ProductAttachmentService
  ) {}

  @Get("getProductList/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Items tab page (Data, TotalCount, PageNo, RowLimit, UIDs)" })
  // Argument order sets the Swagger parameter order: orgId, pageNo, RowLimit, Filter, langCode
  async getProductList(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: ProductListDto) {
    return ciSuccess(await this.items.getPage(org.orgId, Number(pageNo) || 1, 0, dto));
  }

  @Get("getGroupList/:pageNo")
  @ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" })
  @ApiOperation({ summary: "Groups (combo) tab page (Data, TotalCount, PageNo, RowLimit, UIDs)" })
  async getGroupList(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: ProductListDto) {
    return ciSuccess(await this.items.getPage(org.orgId, Number(pageNo) || 1, 1, dto));
  }

  @Get("retrieveProductDetails")
  @ApiOperation({ summary: "One product with rental config, images and variants (edit form)" })
  async retrieveProductDetails(@Query() dto: ItemQueryDto) {
    return ciSuccess(await this.items.getDetail(dto.orgId, postInt(dto, "ItemUID"), dto.langCode));
  }

  @Post("addProductData")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("ProdAttachFiles")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({
    summary: "Create an item (stock, variants, rental config, images as ProdAttachFiles[])",
    description: "Validation errors return { Error: true, Message: <messages>, Errors: 'Please correct the highlighted errors.' }. On success: Message, ProductUID, Product.",
  })
  async addProductData(@Body() dto: ProductFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.writes.create(dto, writeContext(dto, req), filesOf(files, "ProdAttachFiles")));
  }

  @Post("updateProductData")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("ProdAttachFiles")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update an item (same fields as create plus ProductUID and ProdAttachDeleteUIDs) (Message, ProductUID)" })
  async updateProductData(@Body() dto: ProductFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.writes.update(dto, writeContext(dto, req), filesOf(files, "ProdAttachFiles")));
  }

  @Post("deleteProductDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete an item (refused if in a combo or used in transactions)" })
  async deleteProductDetails(@Body() dto: ProductIdDto, @Req() req: Request) {
    return ciSuccess(await this.writes.delete(dto, writeContext(dto, req)));
  }

  @Post("deleteBulkProduct")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete several items, or all matching a filter (SelectAll = 1)" })
  async deleteBulkProduct(@Body() dto: ProductBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.writes.deleteBulk(dto, writeContext(dto, req)));
  }

  @Post("toggleProductStatus")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Activate (IsActive = 1) or deactivate (0) an item" })
  async toggleProductStatus(@Body() dto: ProductStatusDto, @Req() req: Request) {
    return ciSuccess(await this.writes.setStatus(dto, writeContext(dto, req)));
  }

  @Get("getItemsForBOM")
  @ApiOperation({ summary: "Combo component search: up to 50 items (Items)" })
  async getItemsForBOM(@Query() dto: BomSearchDto) {
    return ciSuccess(await this.items.itemsForBOM(dto.orgId, dto.search, dto.langCode));
  }

  @Post("addComboItem")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create a combo (group) item with at least 2 components; getTableDetails = 1 also returns the groups page and Stats" })
  async addComboItem(@Body() dto: ComboFormDto, @Req() req: Request) {
    return ciSuccess(await this.writes.saveCombo(dto, writeContext(dto, req), false));
  }

  @Post("editComboItem")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Update a combo item and replace its components" })
  async editComboItem(@Body() dto: ComboFormDto, @Req() req: Request) {
    return ciSuccess(await this.writes.saveCombo(dto, writeContext(dto, req), true));
  }

  @Get("retrieveComboDetails")
  @ApiOperation({ summary: "Combo item with its components (Data, Components)" })
  async retrieveComboDetails(@Query() dto: ComboQueryDto) {
    return ciSuccess(await this.items.getCombo(dto.orgId, postInt(dto, "ComboUID"), dto.langCode));
  }

  @Get("getTransComboComponents")
  @ApiOperation({ summary: "Combo components with selling price, for the transaction forms (Components)" })
  async getTransComboComponents(@Query() dto: ProductQueryDto) {
    return ciSuccess(await this.items.getComboComponents(postInt(dto, "ProductUID"), dto.langCode));
  }

  @Get("getVariantStock")
  @ApiOperation({ summary: "A product's variants with stock (Data)" })
  async getVariantStock(@Query() dto: ProductQueryDto) {
    return ciSuccess(await this.items.getVariants(dto.orgId, postInt(dto, "ProductUID")));
  }

  @Get("getUsedVariants")
  @ApiOperation({ summary: "Variants already used in transactions (Data: VariantUID, SizeUID, BrandUID)" })
  async getUsedVariants(@Query() dto: ProductQueryDto) {
    return ciSuccess(await this.items.getUsedVariants(dto.orgId, postInt(dto, "ProductUID")));
  }

  @Get("getProductVariantsForPricelist")
  @ApiOperation({ summary: "A product's variants with labels for the price-list rules (Variants)" })
  async getProductVariantsForPricelist(@Query() dto: ProductQueryDto) {
    return ciSuccess(await this.items.getVariantsForPriceList(dto.orgId, postInt(dto, "ProductUID")));
  }

  @Get("getAvailableSerials")
  @ApiOperation({ summary: "Serial numbers in stock for a serial-tracked product (Serials, Count)" })
  async getAvailableSerials(@Query() dto: ProductQueryDto) {
    return ciSuccess(await this.items.getAvailableSerials(dto.orgId, postInt(dto, "ProductUID")));
  }

  @Get("getDropdownCache")
  @ApiOperation({ summary: "Lookup lists of the product form (Data: primaryUnit, discType, prodType, prodTax, taxDetails, categories, brands)" })
  async getDropdownCache(@Query() dto: DropdownCacheDto) {
    return ciSuccess(await this.items.getDropdowns(dto.orgId, dto.fields, dto.langCode));
  }

  @Post("syncProductsCache")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Rebuild the Upstash products cache (Message, Count)" })
  async syncProductsCache(@Body() dto: OrgContextDto) {
    const count = await this.cache.syncProducts(dto.orgId);
    if (count === 0) throw new CiValidationError("No active items found.");
    return ciSuccess({ Message: `${count} item(s) synced to cache.`, Count: count });
  }

  @Get("getProductProfileTab/:uid/:tab")
  @ApiParam({ name: "tab", enum: ["overview", "transactions", "stock", "history"] })
  @ApiOperation({ summary: "Product profile tab as data (Tab, Data; transactions: Rows) — CI3 returned HTML" })
  async getProductProfileTab(@Param("uid") uid: string, @Param("tab") tab: string, @Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.profile.getTab(dto.orgId, Number(uid), tab, dto.langCode));
  }

  @Get("getAttachments")
  @ApiOperation({ summary: "Images of a product, category or brand (Attachments with Url)" })
  async getAttachments(@Query() dto: EntityAttachmentsDto) {
    return ciSuccess(await this.attachments.list(dto.orgId, dto.EntityType, postInt(dto, "EntityUID")));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ─────────

  @Get("getRentalConfig")
  @ApiExcludeEndpoint()
  async getRentalConfig(@Query() dto: ProductQueryDto) {
    return ciSuccess(await this.items.getRentalConfig(dto.orgId, postInt(dto, "ProductUID")));
  }

  @Post("deleteComboItem")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async deleteComboItem(@Body() dto: ComboIdDto, @Req() req: Request) {
    return ciSuccess(await this.writes.deleteCombo(dto, writeContext(dto, req)));
  }

  @Post("recalcStock")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async recalcStock(@Body() dto: RecalcStockDto, @Req() req: Request) {
    return ciSuccess(await this.writes.recalcStock(dto, writeContext(dto, req)));
  }

  @Post("saveAttachments")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("Attachments")
  @ApiExcludeEndpoint()
  async saveAttachments(@Body() dto: EntityAttachmentsSaveDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.attachments.save(writeContext(dto, req), dto.EntityType, postInt(dto, "EntityUID"), filesOf(files, "Attachments")));
  }

  @Post("deleteAttachment")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async deleteAttachment(@Body() dto: EntityAttachmentDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.attachments.deleteOne(writeContext(dto, req), postInt(dto, "AttachUID"), dto.EntityType, postInt(dto, "EntityUID")));
  }
}
