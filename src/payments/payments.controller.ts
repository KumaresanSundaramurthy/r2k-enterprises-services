import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { PaymentsService } from "./payments.service";
import { VerifyPaymentDto } from "./dto/verify-payment.dto";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { JwtPayload } from "../common/interfaces/jwt-payload.interface";

@ApiTags("Payments")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("api/payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post("create-order")
  @ApiOperation({ summary: "Create a Razorpay order for the current cart total" })
  createRazorpayOrder(@CurrentUser() user: JwtPayload) {
    return this.paymentsService.createRazorpayOrder(user.userId);
  }

  @Post("verify")
  @ApiOperation({ summary: "Verify a Razorpay payment signature and place the order" })
  verifyRazorpayPayment(@CurrentUser() user: JwtPayload, @Body() dto: VerifyPaymentDto) {
    return this.paymentsService.verifyRazorpayPayment(user.userId, user.orgUID, dto);
  }
}
