import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, MinLength } from "class-validator";

export class RegisterDto {
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
