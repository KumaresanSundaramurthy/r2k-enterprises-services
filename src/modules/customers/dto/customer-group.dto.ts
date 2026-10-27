import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { Allow, IsArray, IsIn, IsInt, IsOptional, IsString, Min, ValidateNested } from "class-validator";
import { OrgPagedListDto } from "../../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";
import { toArray, toOptionalNumber } from "../../../core/dto/transforms";

// Filter keys are the same as the CI3 groups tab posts (Filter[...]).
export class GroupListFilterDto {
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

  @ApiPropertyOptional({ description: "Only groups this customer belongs to" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  CustomerUID?: number;
}

export class GroupListDto extends OrgPagedListDto {
  @ApiPropertyOptional({ type: GroupListFilterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => GroupListFilterDto)
  Filter?: GroupListFilterDto;
}

// The CI3 group form, field for field. Values are checked by the service so messages match CI3.
export class GroupFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Required on update" }) @Allow() GroupUID?: string | number;
  @ApiPropertyOptional() @Allow() GroupName?: string;
  @ApiPropertyOptional() @Allow() GroupCode?: string;
  @ApiPropertyOptional({ description: "One of the group types; anything else becomes 'Business Group'" }) @Allow() GroupType?: string;
  @ApiPropertyOptional() @Allow() ContactPerson?: string;
  @ApiPropertyOptional() @Allow() Mobile?: string;
  @ApiPropertyOptional() @Allow() MobileCountryCode?: string;
  @ApiPropertyOptional() @Allow() Email?: string;
  @ApiPropertyOptional() @Allow() GSTIN?: string;
  @ApiPropertyOptional() @Allow() GSTINValidated?: string | number;
  @ApiPropertyOptional() @Allow() AddrLine1?: string;
  @ApiPropertyOptional() @Allow() AddrLine2?: string;
  @ApiPropertyOptional() @Allow() AddrCity?: string;
  @ApiPropertyOptional() @Allow() AddrState?: string;
  @ApiPropertyOptional() @Allow() AddrStateCode?: string;
  @ApiPropertyOptional() @Allow() AddrPincode?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({ type: [Number], description: "CustomerUIDs in the group" }) @Allow() MemberUIDs?: (string | number)[];
  @ApiPropertyOptional({ type: Number, description: "Primary member (one of MemberUIDs)" }) @Allow() PrimaryUID?: string | number;
}

export class GroupIdDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() GroupUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Groups page to return after the change (default 1)" }) @Allow() PageNo?: string | number;
}

export class GroupStatusDto extends GroupIdDto {
  @ApiPropertyOptional({ enum: [0, 1] }) @Allow() IsActive?: string | number;
}
