import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty } from "class-validator";

export class ShippingAddressDto {
  @ApiProperty({ example: "Jane Doe" })
  @IsNotEmpty()
  fullName!: string;

  @ApiProperty({ example: "221B Baker Street" })
  @IsNotEmpty()
  addressLine!: string;

  @ApiProperty({ example: "Chennai" })
  @IsNotEmpty()
  city!: string;

  @ApiProperty({ example: "Tamil Nadu" })
  @IsNotEmpty()
  state!: string;

  @ApiProperty({ example: "600001" })
  @IsNotEmpty()
  pincode!: string;

  @ApiProperty({ example: "9876543210" })
  @IsNotEmpty()
  phone!: string;
}
