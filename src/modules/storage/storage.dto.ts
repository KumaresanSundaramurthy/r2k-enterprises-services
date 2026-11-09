import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Allow, IsArray, IsOptional, IsString, ValidateNested } from "class-validator";
import { OrgPagedListDto } from "../../core/dto/org-context.dto";
import { toArray, toJsonObject } from "../../core/dto/transforms";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";

const toIntArray = ({ value }: { value: unknown }) => {
  const list = toArray({ value }) as unknown[] | undefined;
  return list?.map((item) => parseInt(String(item), 10)).filter((item) => !Number.isNaN(item));
};

// The list filter of the CI3 storage page (Filter[...])
export class StorageFilterDto {
  @ApiPropertyOptional({ description: "Matches Name, ShortName or Description" }) @IsOptional() @IsString() SearchAllData?: string;
  @ApiPropertyOptional({ type: [Number], description: "StorageTypeUIDs" }) @IsOptional() @Transform(toIntArray) @IsArray() StorageType?: number[];
}

export class StorageListDto extends OrgPagedListDto {
  @ApiPropertyOptional({ type: Number, description: "1-based page number; used when it is not in the path" }) @Allow() PageNo?: string | number;

  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { SearchAllData, StorageType[] }" })
  @IsOptional()
  @Transform(toJsonObject(StorageFilterDto))
  @ValidateNested()
  Filter?: StorageFilterDto;
}

// Writes answer with the refreshed list page for the posted RowLimit / PageNo / Filter (as CI3 does)
class StorageWriteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Rows of the refreshed list page (default: the org's RowLimit)" }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Page of the refreshed list (default 1)" }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional({ type: String, description: "List filter as JSON: { SearchAllData, StorageType[] }" }) @Allow() Filter?: string;
  @ApiPropertyOptional({ example: "en", description: "UI language of the refreshed list" }) @Allow() langCode?: string;
}

export class StorageFormDto extends StorageWriteDto {
  @ApiPropertyOptional({ type: Number, description: "Required on update (0 on create)" }) @Allow() StorageUID?: string | number;
  @ApiPropertyOptional({ description: "3 to 100 characters; Tamil is stored in English with a Tamil translation" }) @Allow() Name?: string;
  @ApiPropertyOptional({ description: "Required, up to 25 characters, unique" }) @Allow() ShortName?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() StorageTypeUID?: string | number;
  @ApiPropertyOptional() @Allow() Description?: string;
  @ApiPropertyOptional({ description: "Update: non-empty = remove the current image" }) @Allow() ImageRemoved?: string | number;
  @ApiPropertyOptional({ type: "string", format: "binary", description: "Storage image" }) UploadImage?: unknown;
}

export class StorageIdDto extends StorageWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() StorageUID?: string | number;
}

export class StorageBulkDeleteDto extends StorageWriteDto {
  @ApiPropertyOptional({ type: [Number], description: "StorageUIDs[]" }) @Allow() StorageUIDs?: (string | number)[] | string | number;
}
