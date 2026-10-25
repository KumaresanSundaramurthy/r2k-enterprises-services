import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class VerifyEmailDto {
  @ApiProperty({ description: "Token from the verification link" })
  @IsString()
  @IsNotEmpty()
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty({ example: "jane@example.com", description: "Organisation email or username" })
  @IsString()
  @IsNotEmpty()
  identifier!: string;
}
