import { ApiProperty } from "@nestjs/swagger";
import { IsIn } from "class-validator";
import { OrderStatus } from "../orders.repository";

const VALID_STATUSES: OrderStatus[] = ["pending", "confirmed", "shipped", "delivered", "cancelled"];

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: VALID_STATUSES })
  @IsIn(VALID_STATUSES)
  status!: OrderStatus;
}
