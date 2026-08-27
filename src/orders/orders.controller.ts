import { Body, Controller, Get, Param, Put, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { OrdersService } from "./orders.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import { OrderStatus } from "./orders.repository";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { AdminGuard } from "../common/guards/admin.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { JwtPayload } from "../common/interfaces/jwt-payload.interface";

@ApiTags("Orders")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("api/orders")
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @ApiOperation({ summary: "Place a cash-on-delivery order from the current cart" })
  createOrder(@CurrentUser() user: JwtPayload, @Body() dto: CreateOrderDto) {
    return this.ordersService.createOrder(user.userId, user.orgUID, dto.shippingAddress);
  }

  @Get()
  @ApiOperation({ summary: "List the current user's orders" })
  listMyOrders(@CurrentUser() user: JwtPayload) {
    return this.ordersService.listMyOrders(user.userId);
  }

  @Get("admin/all")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "List all orders (admin only)" })
  listAllOrders(@Query("status") status?: OrderStatus) {
    return this.ordersService.listAllOrders(status);
  }

  @Put(":id/status")
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: "Update an order's status (admin only)" })
  updateOrderStatus(@Param("id") id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.ordersService.updateOrderStatus(Number(id), dto.status);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get one of the current user's orders by id" })
  getOrder(@CurrentUser() user: JwtPayload, @Param("id") id: string) {
    return this.ordersService.getOrder(user.userId, Number(id));
  }
}
