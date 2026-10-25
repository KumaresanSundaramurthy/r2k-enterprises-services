import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsNotEmpty, IsOptional, IsString, Length } from "class-validator";

export class CompleteOnboardingDto {
  @ApiProperty({ example: "Rishika 2K Enterprises Pvt Ltd" })
  @IsString()
  @IsNotEmpty({ message: "Organisation name is required." })
  orgName!: string;

  @ApiProperty({ example: "Rishika 2K" })
  @IsString()
  @IsNotEmpty({ message: "Brand name is required." })
  brandName!: string;

  @ApiProperty({ example: "R2K", description: "Exactly 3 letters or digits" })
  @IsString()
  @Length(3, 3, { message: "Short code must be exactly 3 alphanumeric characters (e.g. R2K)." })
  shortCode!: string;

  @ApiProperty({ example: "9876543210" })
  @IsString()
  @IsNotEmpty()
  mobile!: string;

  @ApiProperty({ example: "TN|Tamil Nadu", description: "State as 'code|name' (from GET /api/auth/onboarding/states)" })
  @IsString()
  @IsNotEmpty({ message: "Please select a state." })
  state!: string;

  @ApiPropertyOptional({ example: 181 })
  @IsOptional()
  @IsInt()
  timezoneUID?: number;

  @ApiPropertyOptional({ example: "33AAAAA0000A1Z5" })
  @IsOptional()
  @IsString()
  gstin?: string;

  @ApiPropertyOptional({ description: "Used when no verified GSTIN is given" })
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressLine2?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressCity?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  addressPincode?: string;
}
