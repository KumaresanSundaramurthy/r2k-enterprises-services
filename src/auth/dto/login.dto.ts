import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, ValidateIf } from "class-validator";

export class IdentifyDto {
  @ApiProperty({ example: "jane_doe", description: "Username or email address" })
  @IsString()
  @IsNotEmpty()
  identifier!: string;
}

export class LoginDto {
  @ApiPropertyOptional({ description: "Token from POST /api/auth/login/identify (two-step login)" })
  @IsOptional()
  @IsString()
  loginToken?: string;

  @ApiPropertyOptional({ example: "jane_doe", description: "Username or email — required when loginToken is not sent" })
  @ValidateIf((o: LoginDto) => !o.loginToken)
  @IsString()
  @IsNotEmpty()
  identifier?: string;

  @ApiProperty({ example: "Sup3rSecret!", format: "password" })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
