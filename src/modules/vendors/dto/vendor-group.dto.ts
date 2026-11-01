import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { Allow, IsArray, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min, ValidateNested } from "class-validator";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";
import { toArray, toJsonObject, toOptionalNumber } from "../../../core/dto/transforms";

// Filter keys are the same as the CI3 vendor groups tab posts (Filter[...]).
export class VendorGroupListFilterDto {
  @ApiPropertyOptional({ description: "Matches GroupName, GroupCode, GroupType or Mobile" })
  @IsOptional()
  @IsString()
  SearchAllData?: string;

  @ApiPropertyOptional({ enum: [0, 1] })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsIn([0, 1])
  IsActive?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsString({ each: true })
  GroupType?: string[];

  @ApiPropertyOptional({ description: "Only groups this vendor belongs to" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  VendorUID?: number;
}

// getGroupsData query parameters after orgId (OrgContextDto) and the path's pageNo
export class VendorGroupListDto {
  @ApiPropertyOptional({ type: Number, description: "Rows per page; defaults to the organisation's RowLimit setting" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  RowLimit?: number;

  @ApiPropertyOptional({ type: String, description: "List filter as JSON: SearchAllData, IsActive (0 / 1), GroupType[], VendorUID" })
  @IsOptional()
  @Transform(toJsonObject(VendorGroupListFilterDto))
  @ValidateNested()
  Filter?: VendorGroupListFilterDto;

  @ApiPropertyOptional({ example: "en", description: "UI language code; 'en' (default) returns the base text" })
  @IsOptional()
  @Matches(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, { message: "langCode must be a language code such as 'en' or 'ta'" })
  langCode: string = "en";
}

// The CI3 vendor group form, field for field. Values are checked by the service so messages match CI3.
export class VendorGroupFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Required on update" }) @Allow() GroupUID?: string | number;
  @ApiPropertyOptional() @Allow() GroupName?: string;
  @ApiPropertyOptional() @Allow() GroupCode?: string;
  @ApiPropertyOptional({ description: "One of the group types; anything else becomes 'Business Group'" }) @Allow() GroupType?: string;
  @ApiPropertyOptional() @Allow() ContactPerson?: string;
  @ApiPropertyOptional() @Allow() Mobile?: string;
  @ApiPropertyOptional() @Allow() MobileCountryCode?: string;
  @ApiPropertyOptional() @Allow() Email?: string;
  @ApiPropertyOptional() @Allow() GSTIN?: string;
  @ApiPropertyOptional() @Allow() AddrLine1?: string;
  @ApiPropertyOptional() @Allow() AddrLine2?: string;
  @ApiPropertyOptional() @Allow() AddrCity?: string;
  @ApiPropertyOptional() @Allow() AddrState?: string;
  @ApiPropertyOptional() @Allow() AddrStateCode?: string;
  @ApiPropertyOptional() @Allow() AddrPincode?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: [Number], description: "VendorUIDs in the group" }) @Allow() MemberUIDs?: (string | number)[];
  @ApiPropertyOptional({ type: Number, description: "Primary member (one of MemberUIDs)" }) @Allow() PrimaryUID?: string | number;
}

export class VendorGroupIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() GroupUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Groups page to return after the change (default 1)" }) @Allow() PageNo?: string | number;
}

export class VendorGroupStatusDto extends VendorGroupIdDto {
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsActive?: string | number;
}
