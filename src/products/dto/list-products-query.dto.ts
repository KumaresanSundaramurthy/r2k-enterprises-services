import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsNumber, IsOptional, IsString } from "class-validator";

export class ListProductsQueryDto {
  @ApiProperty({ type: Number, description: "OrgUID to list products for" })
  @Type(() => Number)
  @IsInt()
  orgId!: number;

  @ApiPropertyOptional({ description: "Category name" })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: "Case-insensitive match on product name" })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: "Brand name (products are matched via their variants' brand)" })
  @IsOptional()
  @IsString()
  vendor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxPrice?: number;

  @ApiPropertyOptional({ enum: ["newest", "price_asc", "price_desc", "name_asc"] })
  @IsOptional()
  @IsIn(["newest", "price_asc", "price_desc", "name_asc"])
  sort?: string;
}
