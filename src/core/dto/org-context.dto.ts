import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional, Matches, Max, Min } from "class-validator";

// Every CI3-called endpoint is scoped to one organisation, sent by the caller.
export class OrgContextDto {
  @ApiProperty({ type: Number, example: 1, description: "OrgUID" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  orgId!: number;
}

// Endpoints that return translatable text (names, areas, addresses) — CI3's JwtData->User->UILanguage.
export class OrgLangContextDto extends OrgContextDto {
  @ApiPropertyOptional({ example: "en", description: "UI language code; 'en' (default) returns the base text" })
  @IsOptional()
  @Matches(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, { message: "langCode must be a language code such as 'en' or 'ta'" })
  langCode: string = "en";
}

// Paged lists whose page size defaults to the organisation's RowLimit setting.
export class OrgPagedListDto extends OrgLangContextDto {
  @ApiPropertyOptional({ description: "Rows per page; defaults to the organisation's RowLimit setting" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit?: number;
}
