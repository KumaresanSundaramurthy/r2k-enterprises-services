import { Controller, Get, Param, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { Allow, IsInt, IsOptional, Max, Min } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { toJsonObject } from "../../core/dto/transforms";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { PurchasePriceListService } from "./purchase-price-list.service";

class PriceListFilterDto {
  @ApiPropertyOptional({ description: "Words matched against item name, SKU, vendor, HSN code and bill number" }) @Allow() search?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() ProductUID?: number;
  @ApiPropertyOptional({ type: Number }) @Allow() VendorUID?: number;
}

class PagedDto extends OrgContextDto {
  @ApiPropertyOptional({ description: "Rows per page; defaults to the organisation's RowLimit setting" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit?: number;

  @ApiPropertyOptional({ type: Number, description: "1-based page number; used when it is not in the path" }) @Allow() PageNo?: string | number;
}

export class PriceListDto extends PagedDto {
  @ApiProperty({ type: Number, example: 1, description: "BranchUID the user is currently working in" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId!: number;

  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { search, ProductUID, VendorUID }" })
  @IsOptional()
  @Transform(toJsonObject(PriceListFilterDto))
  Filter?: PriceListFilterDto;
}

const pageOf = (pathPage: string | undefined, dto: { PageNo?: string | number }) => Math.max(1, Number(pathPage ?? dto.PageNo) || 1);

/** Purchase Price List page of CI3 (Purchasepricelist controller), same paths as its JS calls; rows are returned as data. */
@ApiTags("Purchase Price List")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/purchasepricelist")
export class PurchasePriceListController {
  constructor(private readonly priceList: PurchasePriceListService) {}

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: "Latest purchase price per product + vendor in the branch (Data, TotalCount, PageNo, RowLimit)" })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: PriceListDto) {
    return ciSuccess(await this.priceList.getPage(dto.orgId, dto.branchId, pageOf(pageNo, dto), dto.RowLimit, dto.Filter ?? {}));
  }

  @Get("view/:priceListUID")
  @ApiOperation({ summary: "Detail page: the entry (Entry) and the first page of its price history (Data, TotalCount)" })
  async view(@Param("priceListUID") priceListUID: string, @Query() dto: PagedDto) {
    return ciSuccess(await this.priceList.getDetail(dto.orgId, Number(priceListUID) || 0, 1, dto.RowLimit));
  }

  @Get("getDetailPageData/:priceListUID")
  @ApiOperation({ summary: "A page of an entry's price history (Entry, Data, TotalCount, PageNo, RowLimit)" })
  async getDetailPageData(@Param("priceListUID") priceListUID: string, @Query() dto: PagedDto) {
    return ciSuccess(await this.priceList.getDetail(dto.orgId, Number(priceListUID) || 0, pageOf(undefined, dto), dto.RowLimit));
  }
}
