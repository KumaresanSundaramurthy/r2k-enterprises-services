import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { Allow, IsInt, IsOptional } from "class-validator";
import { OrgContextDto, OrgLangContextDto } from "../../../core/dto/org-context.dto";
import { toOptionalNumber } from "../../../core/dto/transforms";

// CustomerUID is checked by the service so the message matches CI3 ("Invalid customer." / "CustomerUID is required.").
export class CustomerBalanceDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  CustomerUID?: number;
}

export class CustomerOpeningBalanceDto extends CustomerBalanceDto {
  @ApiPropertyOptional({ type: Number, description: "Year the financial year starts in, e.g. 2026; defaults to the current FY" })
  @IsOptional()
  @Transform(toOptionalNumber)
  @IsInt()
  FinancialYear?: number;
}

// getCustomerStatementTab — dates YYYY-MM-DD, default the current month
export class CustomerStatementDto extends OrgLangContextDto {
  @ApiPropertyOptional({ type: Number }) @Allow() CustomerUID?: string | number;
  @ApiPropertyOptional({ example: "2026-10-01" }) @Allow() FromDate?: string;
  @ApiPropertyOptional({ example: "2026-10-31" }) @Allow() ToDate?: string;
}
