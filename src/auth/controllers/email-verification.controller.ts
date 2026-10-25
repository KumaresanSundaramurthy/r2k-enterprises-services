import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ResendVerificationDto, VerifyEmailDto } from "../dto/email-verification.dto";
import { EmailVerificationService } from "../services/email-verification.service";

@ApiTags("Auth — Email verification")
@Controller("api/auth/email")
export class EmailVerificationController {
  constructor(private readonly emailVerificationService: EmailVerificationService) {}

  @Post("verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Verify the organisation email",
    description: "Returns success or already_verified; expired links return 410 and unknown links 404.",
  })
  verify(@Body() dto: VerifyEmailDto) {
    return this.emailVerificationService.verify(dto.token);
  }

  @Post("resend-verification")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Resend the verification email",
    description: "Always returns the same message, so it cannot be used to discover accounts.",
  })
  resend(@Body() dto: ResendVerificationDto) {
    return this.emailVerificationService.resend(dto.identifier);
  }
}
