import { Controller, Get, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsInt, IsNotEmpty, IsString, Min } from "class-validator";
import { CiServerGuard } from "../../common/guards/ci-server.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { ErpUserRepository } from "../repositories/erp-user.repository";

class UserByIdentifierDto {
  @ApiProperty({ description: "UserName or EmailAddress (matched exactly, as CI3)" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  identifier!: string;
}

class UserByUIDDto {
  @ApiProperty({ type: Number, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  UserUID!: number;
}

// User_model lookups for CI3 server code (OAuth, Signup, password changes, session / menu cache rebuilds).
// Rows carry the password hash, so only CI3's server may call these (CiServerGuard), never the browser.
@ApiTags("Users (CI3 server)")
@ApiBearerAuth()
@UseGuards(CiServerGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/users")
export class CiUserLookupController {
  constructor(private readonly users: ErpUserRepository) {}

  @Get("getUserByEmailOrUsername")
  @ApiOperation({
    summary: "User_model::getUserByEmailOrUsername — active login users matching the UserName or EmailAddress ({Data: [...]})",
    description: "Every match is returned, as CI3 (callers require exactly one). Needs a CI3 server token: { purpose: 'ci-server' }, at most 5 minutes.",
  })
  async getUserByEmailOrUsername(@Query() dto: UserByIdentifierDto) {
    return ciSuccess({ Data: await this.users.findLoginUsersByIdentifier(dto.identifier) }, "Success");
  }

  @Get("getUserByUID")
  @ApiOperation({
    summary: "User_model::getUserByUID — the active login user ({Data: [row]} or {Data: []})",
    description: "Needs a CI3 server token: { purpose: 'ci-server' }, at most 5 minutes.",
  })
  async getUserByUID(@Query() dto: UserByUIDDto) {
    const user = await this.users.findLoginUserByUID(dto.UserUID);
    return ciSuccess({ Data: user ? [user] : [] }, "Success");
  }

  @Get("getUserByUserInfo")
  @ApiOperation({
    summary: "User_model::getUserByUserInfo(['User.UserUID' => id]) — the active user, login access not required ({Data: [row]} or {Data: []})",
    description: "Needs a CI3 server token: { purpose: 'ci-server' }, at most 5 minutes.",
  })
  async getUserByUserInfo(@Query() dto: UserByUIDDto) {
    return ciSuccess({ Data: await this.users.findUserInfoByUID(dto.UserUID) }, "Success");
  }
}
