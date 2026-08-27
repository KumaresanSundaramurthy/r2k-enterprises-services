import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsNotEmpty, ValidateNested } from "class-validator";
import { ShippingAddressDto } from "../../orders/dto/shipping-address.dto";

export class VerifyPaymentDto {
  @ApiProperty()
  @IsNotEmpty()
  razorpay_order_id!: string;

  @ApiProperty()
  @IsNotEmpty()
  razorpay_payment_id!: string;

  @ApiProperty()
  @IsNotEmpty()
  razorpay_signature!: string;

  @ApiProperty({ type: ShippingAddressDto })
  @ValidateNested()
  @Type(() => ShippingAddressDto)
  shippingAddress!: ShippingAddressDto;
}
