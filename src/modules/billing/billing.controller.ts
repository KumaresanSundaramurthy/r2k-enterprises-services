import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Response } from "express";
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

  @Post("invoice/regenerate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Re-generate an invoice PDF with the latest template and update PDFPath in DB" })
  async regenerateInvoice(
    @Body() body: { invoiceUID: number; orgUID: number },
  ): Promise<{ url: string | null }> {
    const url = await this.billingService.regenerateInvoicePdf(Number(body.invoiceUID ?? 0), Number(body.orgUID ?? 0));
    return { url };
  }

  @Get("invoice/download")
  @ApiOperation({ summary: "Stream subscription invoice PDF — called directly from the browser with user JWT" })
  async invoiceDownload(
    @Query("invoiceUID") invoiceUID: string,
    @Query("orgUID") orgUID: string,
    @Res() res: Response,
  ): Promise<void> {
    const row = await this.billingService.getInvoicePdfPath(Number(invoiceUID ?? 0), Number(orgUID ?? 0));

    if (!row || !row.PDFPath) {
      res.status(HttpStatus.NOT_FOUND).json({ Error: true, Message: "Invoice PDF not available." });
      return;
    }

    const pdfRes = await fetch(row.PDFPath as string, { signal: AbortSignal.timeout(30000) });
    if (!pdfRes.ok || !pdfRes.body) {
      res.status(HttpStatus.BAD_GATEWAY).json({ Error: true, Message: "Could not fetch invoice PDF." });
      return;
    }

    const safeName = `Invoice-${String(row.InvoiceNumber ?? invoiceUID).replace(/[^A-Za-z0-9\-]/g, "")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Cache-Control", "private, no-store");

    const { Readable } = await import("stream");
    Readable.fromWeb(pdfRes.body as import("stream/web").ReadableStream).pipe(res);
  }
}
