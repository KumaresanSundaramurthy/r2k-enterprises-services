import { Body, Controller, HttpCode, HttpStatus, Post, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { BillingInvoiceData, BillingService } from "./billing.service";

class BillingInvoiceDto implements BillingInvoiceData {
  @Allow() invoice_number!: string;
  @Allow() invoice_date?: string;
  @Allow() financial_year?: string;
  @Allow() org_name?: string;
  @Allow() gstin?: string;
  @Allow() org_address1?: string;
  @Allow() org_address2?: string;
  @Allow() org_city?: string;
  @Allow() org_state?: string;
  @Allow() org_pincode?: string;
  @Allow() org_phone?: string;
  @Allow() org_email?: string;
  @Allow() plan_name?: string;
  @Allow() billing_cycle?: string;
  @Allow() renewal_type?: string;
  @Allow() taxable_amount?: number;
  @Allow() tax_rate?: number;
  @Allow() tax_amount?: number;
  @Allow() total_amount?: number;
  @Allow() order_uid?: number;
  @Allow() org_uid?: number;
}

@ApiTags("Billing")
@ApiBearerAuth()
@Controller("api/billing")
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post("invoice/generate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Generate a subscription invoice PDF and upload to R2" })
  async generateInvoice(@Body() dto: BillingInvoiceDto): Promise<{ url: string | null }> {
    const url = await this.billingService.generateAndUpload(dto);
    return { url };
  }
}
