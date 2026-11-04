import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptForm } from "../products/product-files";
import { PaymentBanksService } from "./payment-banks.service";
import { PaymentReceiptService } from "./payment-receipt.service";
import {
  BankIdDto,
  BankIdQueryDto,
  BankSaveDto,
  PartyIdQueryDto,
  PaymentAddDto,
  PaymentDeleteDto,
  PaymentIdQueryDto,
  PaymentListDto,
  PaymentPdfDto,
  PaymentPrintDto,
  TransIdQueryDto,
} from "./payment-records.dto";
import { PaymentRecordsService } from "./payment-records.service";
import { PaymentWriteService } from "./payment-write.service";

const pageOf = (pathPage: string | undefined, dto: { PageNo?: string | number }) => Math.max(1, Number(pathPage ?? dto.PageNo) || 1);

/**
 * Payments page of CI3 (Payments controller), same method names as its JS calls. Rows are returned as data
 * (CI3 rendered them as HTML). Endpoints the CI3 JS does not call are migrated but hidden from Swagger.
 * Shares the /api/payments prefix with the online store's payment endpoints (create-order, verify).
 */
@ApiTags("Payment Records")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/payments")
export class PaymentRecordsController {
  constructor(
    private readonly records: PaymentRecordsService,
    private readonly writes: PaymentWriteService,
    private readonly receipts: PaymentReceiptService,
    private readonly banks: PaymentBanksService
  ) {}

  @Get("getPageData")
  @ApiOperation({ summary: "Page data: BalanceStats (when shown), BankAccounts, PaymentTypes, OrgUsers, RowLimit and the saved date range (InitFilter)" })
  async getPageData(@Query() dto: OrgUserBranchContextDto) {
    return ciSuccess(await this.records.getPageData(dto.orgId, dto.branchId, dto.userId));
  }

  @Get(["getPaymentsPageDetails", "getPaymentsPageDetails/:pageNo"])
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: "Payments list page, money in and out (Data, TotalCount, PageNo, RowLimit)" })
  async getPaymentsPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: PaymentListDto) {
    return ciSuccess(await this.records.getPage(dto.orgId, pageOf(pageNo, dto), dto.RowLimit, dto.Filter ?? {}));
  }

  @Get("getStats")
  @ApiOperation({ summary: "Cash / bank in and out for the filter (Stats: CashIn, CashOut, BankIn, BankOut), when the organisation shows stats" })
  async getStats(@Query() dto: PaymentListDto) {
    return ciSuccess(await this.records.getStats(dto.orgId, dto.Filter ?? {}));
  }

  @Get("getPaymentsByTransaction")
  @ApiOperation({ summary: "A transaction's payments and their total (Payments, PaidTotal)" })
  async getPaymentsByTransaction(@Query() dto: TransIdQueryDto) {
    return ciSuccess(await this.records.getByTransaction(dto.orgId, postInt(dto, "TransUID")));
  }

  @Get("getPaymentDetail")
  @ApiOperation({ summary: "One payment with its transaction, party and bank (Data)" })
  async getPaymentDetail(@Query() dto: PaymentIdQueryDto) {
    return ciSuccess(await this.records.getDetail(dto.orgId, postInt(dto, "PaymentUID")));
  }

  @Post("deletePayment")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({
    summary: "Cancel (Action = cancel) or delete a payment",
    description: "Refused while its credit is used elsewhere. Returns NewPaidAmount / NewBalanceAmount / NewStatus of the transaction and the customer's balance.",
  })
  async deletePayment(@Body() dto: PaymentDeleteDto, @Req() req: Request) {
    return ciSuccess(await this.writes.remove(writeContext(dto, req), { ...dto }));
  }

  @Get("getPaymentTypes")
  @ApiOperation({ summary: "Payment types (Data: PaymentTypeUID, Name, Code, IsCash)" })
  async getPaymentTypes() {
    return ciSuccess(await this.records.getPaymentTypes());
  }

  @Get("getPaymentPrintDetail")
  @ApiOperation({ summary: "Receipt print data: Payment, OrgInfo and PrintTheme + PrintHtml (A4) or ThermalConfig (thermal)" })
  async getPaymentPrintDetail(@Query() dto: PaymentPrintDto) {
    return ciSuccess(await this.receipts.printDetail(dto.orgId, postInt(dto, "PaymentUID"), String(dto.PrintType ?? "a4")));
  }

  @Get("downloadPaymentPdf")
  @ApiOperation({ summary: "Receipt PDF download — not available yet (CI3 never produced the file either)" })
  async downloadPaymentPdf(@Query() dto: PaymentPdfDto) {
    return this.receipts.pdf(dto.orgId, postInt(dto, "PaymentUID"));
  }

  @Get("getPaymentPdfBase64")
  @ApiOperation({ summary: "Receipt PDF as base64 for e-mail — not available yet (CI3 never produced the file either)" })
  async getPaymentPdfBase64(@Query() dto: PaymentPdfDto) {
    return this.receipts.pdf(dto.orgId, postInt(dto, "PaymentUID"));
  }

  @Get("getCustomerCreditsDetail")
  @ApiOperation({ summary: "A customer's on-account credits and unused advances (OnAccount, Advance and their totals)" })
  async getCustomerCreditsDetail(@Query() dto: PartyIdQueryDto) {
    return ciSuccess(await this.records.getCustomerCredits(dto.orgId, postInt(dto, "PartyUID")));
  }

  @Get("getCustomerCreditNoteDetail")
  @ApiOperation({ summary: "A customer's pending credit notes (CreditNotes, Total)" })
  async getCustomerCreditNoteDetail(@Query() dto: PartyIdQueryDto) {
    return ciSuccess(await this.records.getCustomerCreditNotes(dto.orgId, postInt(dto, "PartyUID")));
  }

  @Get("getCustomerExcessBalance")
  @ApiOperation({ summary: "Credit sources a customer can pay with (TotalCredit, Sources)" })
  async getCustomerExcessBalance(@Query() dto: PartyIdQueryDto) {
    return ciSuccess(await this.records.getCustomerExcessBalance(dto.orgId, postInt(dto, "PartyUID")));
  }

  // ── CI3 functions the JS does not call: migrated, hidden from Swagger ──────────

  @Post("addPayment")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async addPayment(@Body() dto: PaymentAddDto, @Req() req: Request) {
    return ciSuccess(await this.writes.add(writeContext(dto, req), { ...dto }));
  }

  @Get(["getBankAccounts", "getBanksList"])
  @ApiExcludeEndpoint()
  async getBankAccounts(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.records.getBankAccounts(dto.orgId));
  }

  @Get("getBankDetails")
  @ApiExcludeEndpoint()
  async getBankDetails(@Query() dto: BankIdQueryDto) {
    return ciSuccess(await this.records.getBankDetails(dto.orgId, postInt(dto, "BankAccountUID")));
  }

  @Post("saveBankAccount")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async saveBankAccount(@Body() dto: BankSaveDto, @Req() req: Request) {
    return ciSuccess(await this.banks.save(writeContext(dto, req), { ...dto }));
  }

  @Post("setDefaultBank")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async setDefaultBank(@Body() dto: BankIdDto, @Req() req: Request) {
    return ciSuccess(await this.banks.setDefault(writeContext(dto, req), { ...dto }));
  }

  @Post("deleteBankAccount")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async deleteBankAccount(@Body() dto: BankIdDto, @Req() req: Request) {
    return ciSuccess(await this.banks.delete(writeContext(dto, req), { ...dto }));
  }
}
