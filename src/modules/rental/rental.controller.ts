import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { AcceptForm } from "../products/product-files";
import { RentalService } from "./rental.service";

const LIST = "Data (each with Machines), TotalCount, PageNo, RowLimit, Stats";

export class RentalListDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number, description: "1-based page number; used when it is not in the path" }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Rows per page (default: the org's RowLimit)" }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ type: String, description: "Filter as JSON: { Status: All | Active | PartiallyReturned | Overdue | Closed | Cancelled, Search }" })
  @Allow()
  Filter?: unknown;
}

// Writes answer with page 1 of the posted RowLimit / Filter, as CI3 does
class RentalWriteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Rows of the refreshed list (default: the org's RowLimit)" }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ type: String, description: "List filter as JSON: { Status, Search }" }) @Allow() Filter?: unknown;
}

export class RentalCreateDto extends RentalWriteDto {
  @ApiPropertyOptional({ type: Number, description: "Required, one of the org's customers" }) @Allow() CustomerUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD HH:MM[:SS]; default now" }) @Allow() RentalStartDateTime?: string;
  @ApiPropertyOptional({ description: "Required, YYYY-MM-DD HH:MM[:SS]" }) @Allow() ReturnDueDateTime?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() DepositCollected?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() DepositPaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() DepositBankAccountUID?: string | number;
  @ApiPropertyOptional() @Allow() Notes?: string;
  @ApiPropertyOptional({
    description: "JSON array: [{ ProductUID, Qty, RentalType, BaseRentalCharge, SecurityDeposit, HourlyRate, HalfDayRate, FullDayRate, FixedPackageRate, ExtraHourRate, LateReturnChargePerHour }]",
  })
  @Allow()
  Items?: unknown;
}

export class RentalIdDto extends RentalWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() RentalUID?: string | number;
}

export class RentalDetailDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number, description: "Required" }) @Allow() RentalUID?: string | number;
}

export class RentalReturnDto extends RentalWriteDto {
  @ApiPropertyOptional({ type: Number }) @Allow() RentalUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() RentalItemUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "1 up to the quantity rented" }) @Allow() ReturnedQty?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() DamagedQty?: string | number;
  @ApiPropertyOptional({ description: "Default now" }) @Allow() ActualReturnDateTime?: string;
  @ApiPropertyOptional({ type: Number }) @Allow() ActualHours?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() ExtraHourCharge?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() LateReturnCharge?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() DamageCharge?: string | number;
  @ApiPropertyOptional() @Allow() ReturnNotes?: string;
}

export class RentalPaymentDto extends RentalWriteDto {
  @ApiPropertyOptional({ type: Number, description: "The RentalUID (the shared payment modal's TransUID)" }) @Allow() TransUID?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Required" }) @Allow() PaymentTypeUID?: string | number;
  @ApiPropertyOptional({ type: Number }) @Allow() BankAccountUID?: string | number;
  @ApiPropertyOptional({ description: "YYYY-MM-DD; default today" }) @Allow() PaymentDate?: string;
  @ApiPropertyOptional({ type: Number, description: "Greater than 0" }) @Allow() Amount?: string | number;
  @ApiPropertyOptional() @Allow() ReferenceNo?: string;
  @ApiPropertyOptional() @Allow() Notes?: string;
}

export class RentableSearchDto extends OrgContextDto {
  @ApiPropertyOptional({ description: "Matches the item name or part number" }) @Allow() term?: string;
}

/** CI3 Rental controller (module 116). */
@ApiTags("Rental")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/rental")
export class RentalController {
  constructor(private readonly rental: RentalService) {}

  @Get("getPageData")
  @ApiOperation({ summary: `Page data: page 1 of every status (${LIST}), PaymentTypes, BankAccounts` })
  async getPageData(@Query() dto: RentalListDto) {
    return ciSuccess(await this.rental.pageData(dto.orgId, Number(dto.RowLimit) || undefined));
  }

  @Get(["getPageDetails", "getPageDetails/:pageNo"])
  @ApiParam({ name: "pageNo", required: false, description: "1-based page number (or PageNo in the query)" })
  @ApiOperation({ summary: `One list page (${LIST})` })
  async getPageDetails(@Param("pageNo") pageNo: string | undefined, @Query() dto: RentalListDto) {
    const page = Math.max(1, Number(pageNo ?? dto.PageNo) || 1);
    return ciSuccess(await this.rental.page(dto.orgId, page, Number(dto.RowLimit) || undefined, this.rental.listFilter(dto.Filter)));
  }

  @Get("getRentalDetail")
  @ApiOperation({ summary: "One rental with its Items and Payments (Data)" })
  async getRentalDetail(@Query() dto: RentalDetailDto) {
    return ciSuccess(await this.rental.detail(dto.orgId, Number(dto.RentalUID) || 0));
  }

  @Get("searchRentableProducts")
  @ApiOperation({ summary: "The org's rentable products with their rental rates, 50 at most (Products)" })
  async searchRentableProducts(@Query() dto: RentableSearchDto) {
    return ciSuccess(await this.rental.searchProducts(dto.orgId, String(dto.term ?? "")));
  }

  @Post("createRental")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Create a rental with its machines and the deposit collected (Message, RentalUID, RentalNumber and page 1)" })
  async createRental(@Body() dto: RentalCreateDto, @Req() req: Request) {
    return ciSuccess(await this.rental.create(writeContext(dto, req), { ...dto }));
  }

  @Post("processReturn")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Record one machine's return and its charges (Message and page 1)" })
  async processReturn(@Body() dto: RentalReturnDto, @Req() req: Request) {
    return ciSuccess(await this.rental.processReturn(writeContext(dto, req), { ...dto }));
  }

  @Post("recordPayment")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Record a payment against a rental and post its income journal (Message and page 1)" })
  async recordPayment(@Body() dto: RentalPaymentDto, @Req() req: Request) {
    return ciSuccess(await this.rental.recordPayment(writeContext(dto, req), { ...dto }));
  }

  @Post("cancelRental")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Cancel a rental that is not closed (Message and page 1)" })
  async cancelRental(@Body() dto: RentalIdDto, @Req() req: Request) {
    return ciSuccess(await this.rental.cancel(writeContext(dto, req), { ...dto }));
  }
}
