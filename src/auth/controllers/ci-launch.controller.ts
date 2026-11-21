import { Body, Controller, HttpCode, HttpStatus, Post, UseFilters } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow, IsNotEmpty } from "class-validator";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { MailService } from "../../common/mail/mail.service";
import { enquiryNotificationEmail } from "../emails/launch-emails";
import { phpDate } from "../../common/utils/php-compat";

class SendEnquiryDto {
  @IsNotEmpty() name!: string;
  @IsNotEmpty() phone!: string;
  @Allow() email!: string;
  @Allow() product!: string;
  @Allow() message!: string;
}

/* Public endpoint — called directly from the Rishika2K landing page (no auth required). */
@ApiTags("Launch (Public)")
@Controller("api/launch")
@UseFilters(CiExceptionFilter)
export class CiLaunchController {
  constructor(private readonly mail: MailService) {}

  @Post("send-enquiry")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Send website enquiry notification email to business owner" })
  async sendEnquiry(@Body() dto: SendEnquiryDto): Promise<{ ok: boolean }> {
    const receivedAt = phpDate("d M Y, h:i A", new Date());
    const email = enquiryNotificationEmail(
      dto.name,
      dto.phone,
      dto.email   || "",
      dto.product || "",
      dto.message || "",
      receivedAt
    );
    try {
      await this.mail.send("rishikakumaresan@gmail.com", "Rishika 2K Enterprises", email.subject, email.html);
    } catch {
      // The visitor always sees success; a failed email is not reported to them
    }
    return { ok: true };
  }
}
