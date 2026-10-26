import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEmail, IsInt, IsNotEmpty, MinLength } from "class-validator";

export class ShopRegisterDto {
  @ApiProperty({ type: Number, example: 1, description: "OrgUID the customer registers under" })
  @Type(() => Number)
  @IsInt()
  orgId!: number;

  @ApiProperty({ example: "Jane Doe" })
  @IsNotEmpty()
  name!: string;

  @ApiProperty({ example: "jane@example.com" })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: "Sup3rSecret!", format: "password" })
  @MinLength(6)
  password!: string;
}
