import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Allow, IsOptional, IsString, ValidateNested } from "class-validator";
import { OrgPagedListDto } from "../../../core/dto/org-context.dto";
import { toJsonObject } from "../../../core/dto/transforms";
import { OrgUserContextDto } from "../../../core/dto/write-context.dto";

export class BranchListFilterDto {
  @ApiPropertyOptional({ description: "Matches the branch name, code or GSTIN" }) @IsOptional() @IsString() Search?: string;
}

export class BranchListDto extends OrgPagedListDto {
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { Search }" })
  @IsOptional()
  @Transform(toJsonObject(BranchListFilterDto))
  @ValidateNested()
  Filter?: BranchListFilterDto;
}

/** The CI3 branch modal, field for field (same names the CI3 JS posts). */
export class BranchFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = new branch, > 0 = BranchUID to update" }) @Allow() BranchUID?: string | number;
  @ApiPropertyOptional({ description: "Required; Tamil text is stored in English with a Tamil translation row" }) @Allow() Name?: string;
  @ApiPropertyOptional({ description: "Required, unique in the organisation, stored in upper case" }) @Allow() BranchCode?: string;
  @ApiPropertyOptional() @Allow() ShortDescription?: string;
  @ApiPropertyOptional() @Allow() BranchTypeUID?: string | number;
  @ApiPropertyOptional() @Allow() ContactPerson?: string;
  @ApiPropertyOptional() @Allow() MobileNumber?: string;
  @ApiPropertyOptional() @Allow() AlternateNumber?: string;
  @ApiPropertyOptional({ example: "+91" }) @Allow() CountryCode?: string;
  @ApiPropertyOptional({ example: "IN" }) @Allow() CountryISO2?: string;
  @ApiPropertyOptional() @Allow() EmailAddress?: string;
  @ApiPropertyOptional() @Allow() PANNumber?: string;
  @ApiPropertyOptional() @Allow() GSTIN?: string;
  @ApiPropertyOptional() @Allow() AddressLine1?: string;
  @ApiPropertyOptional() @Allow() AddressLine2?: string;
  @ApiPropertyOptional() @Allow() Pincode?: string;
  @ApiPropertyOptional() @Allow() StateId?: string | number;
  @ApiPropertyOptional() @Allow() StateText?: string;
  @ApiPropertyOptional() @Allow() CityId?: string | number;
  @ApiPropertyOptional() @Allow() CityText?: string;
  @ApiPropertyOptional() @Allow() Landmark?: string;
  @ApiPropertyOptional({ description: "1 = make this the head office (clears it on the others)" }) @Allow() IsHeadOffice?: string | number;
  @ApiPropertyOptional() @Allow() IsWarehouse?: string | number;
  @ApiPropertyOptional() @Allow() IsDispatchPoint?: string | number;
  @ApiPropertyOptional() @Allow() IsSalesPoint?: string | number;
  @ApiPropertyOptional() @Allow() IsServiceCenter?: string | number;
}

export class BranchIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() BranchUID?: string | number;
}

export class BranchStatusDto extends BranchIdDto {
  @ApiProperty({ type: Number, description: "Current status: 1 = active (it is deactivated), 0 = inactive (it is activated)" })
  @Allow()
  IsActive?: string | number;
}

// switchBranch — the logged-in session decides which branches are allowed
export class SwitchBranchDto {
  @ApiProperty({ type: Number }) @Allow() BranchUID?: string | number;
}
