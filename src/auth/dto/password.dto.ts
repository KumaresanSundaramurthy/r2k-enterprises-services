import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class ForcedPasswordChangeDto {
  @ApiProperty({ description: "changeToken returned by login when nextStep is FORCE_PASSWORD_CHANGE" })
  @IsString()
  @IsNotEmpty()
  changeToken!: string;

  @ApiProperty({ format: "password", minLength: 8 })
  @IsString()
  @IsNotEmpty()
  newPassword!: string;

  @ApiProperty({ format: "password" })
  @IsString()
  @IsNotEmpty()
  confirmPassword!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: "jane@example.com" })
  @IsEmail({}, { message: "Please enter a valid email address." })
  email!: string;

  @ApiProperty({ example: "http://localhost:8080/app", description: "CI3 app base URL — used to build the reset link in the email", required: false })
  @IsOptional()
  @IsString()
  appBaseUrl?: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: "Token from the reset link" })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ format: "password", minLength: 8 })
  @IsString()
  @IsNotEmpty()
  newPassword!: string;

  @ApiProperty({ format: "password" })
  @IsString()
  @IsNotEmpty()
  confirmPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: "password" })
  @IsString()
  @IsNotEmpty()
  oldPassword!: string;

  @ApiProperty({ format: "password", minLength: 8 })
  @IsString()
  @IsNotEmpty()
  newPassword!: string;

  @ApiProperty({ format: "password" })
  @IsString()
  @IsNotEmpty()
  confirmPassword!: string;
}

export class SetPasswordDto {
  @ApiProperty({ description: "Token from the staff invite link" })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({ format: "password", minLength: 6 })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiProperty({ format: "password" })
  @IsString()
  @IsNotEmpty()
  confirmPassword!: string;
}
