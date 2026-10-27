import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, Min } from "class-validator";
import { OrgContextDto } from "./org-context.dto";

// Every write records who made it (CreatedBy / UpdatedBy / audit log); the CI3 JS sends the logged-in user.
export class OrgUserContextDto extends OrgContextDto {
  @ApiProperty({ type: Number, example: 1, description: "UserUID of the logged-in user" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId!: number;
}

// Writes that store the active branch (CI3 JwtData->Org->BranchUID, which changes when the user switches branch).
export class OrgUserBranchContextDto extends OrgUserContextDto {
  @ApiProperty({ type: Number, example: 1, description: "BranchUID the user is currently working in" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  branchId!: number;
}
