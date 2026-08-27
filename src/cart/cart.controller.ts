import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CartService } from "./cart.service";
import { AddToCartDto } from "./dto/add-to-cart.dto";
import { UpdateCartItemDto } from "./dto/update-cart-item.dto";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { JwtPayload } from "../common/interfaces/jwt-payload.interface";

@ApiTags("Cart")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("api/cart")
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  @ApiOperation({ summary: "Get the current user's cart" })
  getCart(@CurrentUser() user: JwtPayload) {
    return this.cartService.getCart(user.userId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add an item to the cart" })
  addToCart(@CurrentUser() user: JwtPayload, @Body() dto: AddToCartDto) {
    return this.cartService.addToCart(user.userId, user.orgUID, dto);
  }

  @Put()
  @ApiOperation({ summary: "Update the quantity of an item already in the cart" })
  updateCartItem(@CurrentUser() user: JwtPayload, @Body() dto: UpdateCartItemDto) {
    return this.cartService.updateCartItem(user.userId, dto);
  }

  @Delete(":productId")
  @ApiOperation({ summary: "Remove an item from the cart" })
  removeFromCart(
    @CurrentUser() user: JwtPayload,
    @Param("productId") productId: string,
    @Query("variantId") variantId?: string
  ) {
    return this.cartService.removeFromCart(user.userId, Number(productId), variantId ? Number(variantId) : null);
  }
}
