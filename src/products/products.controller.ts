import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { ProductsService } from "./products.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ListProductsQueryDto } from "./dto/list-products-query.dto";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { AdminGuard } from "../common/guards/admin.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { JwtPayload } from "../common/interfaces/jwt-payload.interface";

@ApiTags("Products")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("api/products")
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({ summary: "List products for the caller's organisation" })
  listProducts(@Query() query: ListProductsQueryDto) {
    return this.productsService.listProducts(query);
  }

  @Get("meta/categories")
  @ApiOperation({ summary: "List active categories for the caller's organisation" })
  listCategories(@CurrentUser() user: JwtPayload) {
    return this.productsService.listCategories(user.orgUID);
  }

  @Get("meta/vendors")
  @ApiOperation({ summary: "List brands in use across the organisation's product variants" })
  listVendors(@CurrentUser() user: JwtPayload) {
    return this.productsService.listVendors(user.orgUID);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get the complete record for a product by id and organisation" })
  getProduct(@Param("id", ParseIntPipe) id: number, @Query("orgId", ParseIntPipe) orgId: number) {
    return this.productsService.getProduct(orgId, id);
  }

  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Create a product (admin only)" })
  createProduct(@CurrentUser() user: JwtPayload, @Body() dto: CreateProductDto) {
    return this.productsService.createProduct(user.orgUID, dto);
  }

  @Put(":id")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Update a product's base fields and/or stock (admin only)" })
  updateProduct(
    @CurrentUser() user: JwtPayload,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto
  ) {
    return this.productsService.updateProduct(user.orgUID, id, dto);
  }

  @Delete(":id")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Soft-delete a product (admin only)" })
  deleteProduct(@CurrentUser() user: JwtPayload, @Param("id", ParseIntPipe) id: number) {
    return this.productsService.deleteProduct(user.orgUID, id);
  }
}
