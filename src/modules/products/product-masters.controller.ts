import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UploadedFiles, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgLangContextDto } from "../../core/dto/org-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { CategoryListDto, PriceListListDto, SizeListDto } from "./dto/product-list.dto";
import {
  BrandBulkDeleteDto,
  BrandFormDto,
  BrandIdDto,
  BrandQueryDto,
  CategoryBulkDeleteDto,
  CategoryFormDto,
  CategoryIdDto,
  CategoryQueryDto,
  PriceListBulkDeleteDto,
  PriceListDeleteDto,
  PriceListFormDto,
  PriceListQueryDto,
  QuickSizeDto,
  SizeBulkDeleteDto,
  SizeFormDto,
  SizeIdDto,
} from "./dto/product-write.dto";
import { PriceListsService } from "./price-lists.service";
import { ProductBrandsService } from "./product-brands.service";
import { ProductCategoriesService } from "./product-categories.service";
import { AcceptFiles, AcceptForm, FileFields, filesOf } from "./product-files";
import { ProductSizesService } from "./product-sizes.service";

const PAGE_PARAM = ApiParam({ name: "pageNo", description: "1-based page number (0 or invalid = 1)" });

// Categories tab of the CI3 Products page
@ApiTags("Product Categories")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/products")
export class ProductCategoriesController {
  constructor(private readonly categories: ProductCategoriesService) {}

  @Get("getCategoryList/:pageNo")
  @PAGE_PARAM
  @ApiOperation({ summary: "Categories tab page (Data, TotalCount, PageNo, RowLimit, UIDs)" })
  async getCategoryList(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: CategoryListDto) {
    return ciSuccess(await this.categories.getPage(org.orgId, Number(pageNo) || 1, dto));
  }

  @Get("getCategoryOptions")
  @ApiOperation({ summary: "Active categories as options (Options: [{ uid, name }])" })
  async getCategoryOptions(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.categories.getOptions(dto.orgId, dto.langCode));
  }

  @Get("getProductsByCategory")
  @ApiOperation({ summary: "Active products of a category (Products, Count)" })
  async getProductsByCategory(@Query() dto: CategoryQueryDto) {
    return ciSuccess(await this.categories.getProducts(dto.orgId, postInt(dto, "CategoryUID"), dto.langCode));
  }

  @Get("retrieveCategoryDetails")
  @ApiOperation({ summary: "One category (edit form)" })
  async retrieveCategoryDetails(@Query() dto: CategoryQueryDto) {
    return ciSuccess(await this.categories.getDetail(dto.orgId, postInt(dto, "CategoryUID"), dto.langCode));
  }

  @Post("addCategoryDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("CatgAttachFiles")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a category (images as CatgAttachFiles[]) (Message, InsertId, CategoryName)" })
  async addCategoryDetails(@Body() dto: CategoryFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.categories.save(dto, writeContext(dto, req), filesOf(files, "CatgAttachFiles"), false));
  }

  @Post("updateCategoryDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("CatgAttachFiles")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a category (CategoryUID, CatgAttachDeleteUIDs)" })
  async updateCategoryDetails(@Body() dto: CategoryFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.categories.save(dto, writeContext(dto, req), filesOf(files, "CatgAttachFiles"), true));
  }

  @Post("deleteCategoryDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete a category (refused while products use it)" })
  async deleteCategoryDetails(@Body() dto: CategoryIdDto, @Req() req: Request) {
    return ciSuccess(await this.categories.delete(dto, writeContext(dto, req)));
  }

  @Post("deleteBulkCategory")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete several categories (CategoryUIDs[])" })
  async deleteBulkCategory(@Body() dto: CategoryBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.categories.deleteBulk(dto, writeContext(dto, req)));
  }

  @Post("syncCategoriesCache")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Rebuild the Upstash categories cache (Message, Count)" })
  async syncCategoriesCache(@Body() dto: OrgContextDto) {
    return ciSuccess(await this.categories.syncCache(dto.orgId));
  }

  // ── CI3 function the JS does not call: migrated, hidden from Swagger ──────────

  @Get("getAllCategories")
  @ApiExcludeEndpoint()
  async getAllCategories(@Query() dto: OrgLangContextDto) {
    return ciSuccess(await this.categories.getAll(dto.orgId, dto.langCode));
  }
}

// Brands tab of the CI3 Products page
@ApiTags("Product Brands")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/products")
export class ProductBrandsController {
  constructor(private readonly brands: ProductBrandsService) {}

  @Get("getBrandList/:pageNo")
  @PAGE_PARAM
  @ApiOperation({ summary: "Brands tab page (Data, TotalCount, PageNo, RowLimit)" })
  async getBrandList(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: CategoryListDto) {
    return ciSuccess(await this.brands.getPage(org.orgId, Number(pageNo) || 1, dto));
  }

  @Post("addBrandDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("BrandAttachFiles")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Create a brand (images as BrandAttachFiles[]) (Message, InsertId)" })
  async addBrandDetails(@Body() dto: BrandFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.brands.save(dto, writeContext(dto, req), filesOf(files, "BrandAttachFiles"), false));
  }

  @Post("updateBrandDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptFiles("BrandAttachFiles")
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Update a brand (BrandUID, BrandAttachDeleteUIDs)" })
  async updateBrandDetails(@Body() dto: BrandFormDto, @UploadedFiles() files: FileFields, @Req() req: Request) {
    return ciSuccess(await this.brands.save(dto, writeContext(dto, req), filesOf(files, "BrandAttachFiles"), true));
  }

  @Post("deleteBrandDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete a brand (refused while variants or transactions use it)" })
  async deleteBrandDetails(@Body() dto: BrandIdDto, @Req() req: Request) {
    return ciSuccess(await this.brands.delete(dto, writeContext(dto, req)));
  }

  @Post("deleteBulkBrand")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete several brands (BrandUIDs[])" })
  async deleteBulkBrand(@Body() dto: BrandBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.brands.deleteBulk(dto, writeContext(dto, req)));
  }

  @Post("syncBrandsCache")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Rebuild the Upstash brands cache (Message, Count)" })
  async syncBrandsCache(@Body() dto: OrgContextDto) {
    return ciSuccess(await this.brands.syncCache(dto.orgId));
  }

  // ── CI3 function the JS does not call: migrated, hidden from Swagger ──────────

  @Get("retrieveBrandDetails")
  @ApiExcludeEndpoint()
  async retrieveBrandDetails(@Query() dto: BrandQueryDto) {
    return ciSuccess(await this.brands.getDetail(dto.orgId, postInt(dto, "BrandUID")));
  }
}

// Sizes tab of the CI3 Products page and the size picker of the product form
@ApiTags("Product Sizes")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/products")
export class ProductSizesController {
  constructor(private readonly sizes: ProductSizesService) {}

  @Get("getSizes")
  @ApiOperation({ summary: "Active sizes for the variant picker (Data: [{ SizeUID, SizeName }])" })
  async getSizes(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.sizes.getAll(dto.orgId));
  }

  @Post("addSize")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Inline add size from the product form (Message, SizeUID)" })
  async addSize(@Body() dto: QuickSizeDto, @Req() req: Request) {
    return ciSuccess(await this.sizes.quickAdd(dto, writeContext(dto, req)));
  }

  @Get("getSizeList/:pageNo")
  @PAGE_PARAM
  @ApiOperation({ summary: "Sizes tab page (Data, TotalCount, PageNo, RowLimit)" })
  async getSizeList(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: SizeListDto) {
    return ciSuccess(await this.sizes.getPage(org.orgId, Number(pageNo) || 1, dto));
  }

  @Post("addSizeDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create a size with its measurements (Message, InsertId)" })
  async addSizeDetails(@Body() dto: SizeFormDto, @Req() req: Request) {
    return ciSuccess(await this.sizes.save(dto, writeContext(dto, req), false));
  }

  @Post("updateSizeDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Update a size (SizeUID)" })
  async updateSizeDetails(@Body() dto: SizeFormDto, @Req() req: Request) {
    return ciSuccess(await this.sizes.save(dto, writeContext(dto, req), true));
  }

  @Post("deleteSizeDetails")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Deactivate a size (refused while variants use it)" })
  async deleteSizeDetails(@Body() dto: SizeIdDto, @Req() req: Request) {
    return ciSuccess(await this.sizes.delete(dto, writeContext(dto, req)));
  }

  @Post("deleteBulkSize")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Deactivate several sizes (SizeUIDs[])" })
  async deleteBulkSize(@Body() dto: SizeBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.sizes.deleteBulk(dto, writeContext(dto, req)));
  }

  @Post("syncSizesCache")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Rebuild the Upstash sizes cache (Message, Count)" })
  async syncSizesCache(@Body() dto: OrgContextDto) {
    return ciSuccess(await this.sizes.syncCache(dto.orgId));
  }
}

// Price Lists tab of the CI3 Products page
@ApiTags("Price Lists")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/products")
export class PriceListsController {
  constructor(private readonly priceLists: PriceListsService) {}

  @Get("getPriceListData/:pageNo")
  @PAGE_PARAM
  @ApiOperation({ summary: "Price lists tab page (Data, TotalCount, PageNo, RowLimit)" })
  async getPriceListData(@Query() org: OrgContextDto, @Param("pageNo") pageNo: string, @Query() dto: PriceListListDto) {
    return ciSuccess(await this.priceLists.getPage(org.orgId, Number(pageNo) || 1, dto));
  }

  @Get("getPriceListForEdit")
  @ApiOperation({ summary: "Price list with assignments, discounts and rules (edit form)" })
  async getPriceListForEdit(@Query() dto: PriceListQueryDto) {
    return ciSuccess(await this.priceLists.getForEdit(dto.orgId, postInt(dto, "uid"), dto.langCode));
  }

  @Post("savePriceList")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create (PLUID 0) or update a price list; returns the refreshed page (Message, PriceListUID, Data, TotalCount)" })
  async savePriceList(@Body() dto: PriceListFormDto, @Req() req: Request) {
    return ciSuccess(await this.priceLists.save(dto, writeContext(dto, req)));
  }

  @Post("deletePriceList")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete a price list; returns the refreshed page" })
  async deletePriceList(@Body() dto: PriceListDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.priceLists.delete(dto, writeContext(dto, req)));
  }

  @Post("deleteBulkPriceList")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Soft-delete several price lists (PriceListUIDs, comma-separated); returns the refreshed page" })
  async deleteBulkPriceList(@Body() dto: PriceListBulkDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.priceLists.deleteBulk(dto, writeContext(dto, req)));
  }

  @Post("syncPriceListCache")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Rebuild the Upstash price-lists cache (Lists, Message)" })
  async syncPriceListCache(@Body() dto: OrgContextDto) {
    return ciSuccess(await this.priceLists.syncCache(dto.orgId));
  }
}
