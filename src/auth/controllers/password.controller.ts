import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { ErpSession } from "../decorators/erp-session.decorator";
import {
  ChangePasswordDto,
  ForcedPasswordChangeDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SetPasswordDto,
} from "../dto/password.dto";
import { AllowSessionGates, ErpSessionGuard } from "../guards/erp-session.guard";
import { ErpSessionContext } from "../interfaces/erp-session.interface";
import { PasswordService } from "../services/password.service";
import { getRequestMeta } from "../utils/device-info";
import { clearSessionCookie } from "../utils/session-cookie";

@ApiTags("Auth — Password")
@Controller("api/auth/password")
export class PasswordController {
  constructor(private readonly passwordService: PasswordService) {}

  @Post("forced-change")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Change an expired password (180-day rule)",
    description: "Uses the changeToken from login. Minimum 8 characters; the last 3 passwords cannot be reused.",
  })
  forcedChange(@Body() dto: ForcedPasswordChangeDto) {
    return this.passwordService.forcedChange(dto.changeToken, dto.newPassword, dto.confirmPassword);
  }

  @Post("forgot")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Email a password reset link (valid 15 minutes)" })
  forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.passwordService.forgot(dto.email, getRequestMeta(req).ipAddress);
  }

  @Get("reset/:token")
  @ApiOperation({ summary: "Check a reset link — valid (with seconds remaining), expired (410) or invalid (404)" })
  checkResetToken(@Param("token") token: string) {
    return this.passwordService.checkResetToken(token);
  }

  @Post("reset")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reset the password using a reset link token" })
  reset(@Body() dto: ResetPasswordDto) {
    return this.passwordService.reset(dto.token, dto.newPassword, dto.confirmPassword);
  }

  @Post("change")
  @HttpCode(HttpStatus.OK)
  @UseGuards(ErpSessionGuard)
  @AllowSessionGates("expiredSubscription", "pendingPayment", "onboarding")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Change password while logged in — ends the session, so the user signs in again" })
  async change(
    @ErpSession() session: ErpSessionContext,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response
  ) {
    const result = await this.passwordService.change(session, dto.oldPassword, dto.newPassword, dto.confirmPassword);
    clearSessionCookie(res);
    return result;
  }

  @Get("set/:token")
  @ApiOperation({ summary: "Check a staff invite link — state form, already_set, or invalid (404)" })
  checkSetToken(@Param("token") token: string) {
    return this.passwordService.checkSetPasswordToken(token);
  }

  @Post("set")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Set the first password from a staff invite link" })
  setPassword(@Body() dto: SetPasswordDto) {
    return this.passwordService.setInitialPassword(dto.token, dto.password, dto.confirmPassword);
  }
}
