import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, HttpException, HttpStatus, Logger, Post, Res, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Response } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgUserBranchContextDto } from "../../core/dto/write-context.dto";
import { CiValidationError } from "../../core/response/ci-response";
import { AcceptForm } from "../products/product-files";
import { EXPORT_FORMATS } from "./export-config";
import { ExportRequestError, ExportsService } from "./exports.service";

export class ExportDataDto extends OrgUserBranchContextDto {
  @ApiProperty({ type: Number, description: "101-106, 108, 112, 113 documents; 201 Customers, 202 Vendors, 203 Products, 204 Customer Groups, 700 Activity Log" })
  @Allow()
  moduleUID?: string | number;

  @ApiProperty({ enum: EXPORT_FORMATS, description: "print answers { Error, Html }; the others download a file" }) @Allow() format?: string;

  @ApiPropertyOptional({ type: Object, description: "The page's list filter, posted as Filter[key]=value" }) @Allow() Filter?: Record<string, unknown>;
}

/**
 * CI3 Exports::exportData answered errors with an HTTP status (the download JS only looks at the status, so an error
 * must not come back as 200): 400 invalid request, 404 unknown module, 401 token problems, 500 anything else.
 */
@Catch()
class ExportExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Exports::exportData");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof ExportRequestError) {
      res.status(exception.status).json({ Error: true, Message: exception.message });
    } else if (exception instanceof CiValidationError) {
      res.status(HttpStatus.BAD_REQUEST).json({ Error: true, Message: exception.message });
    } else if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const message = typeof body === "string" ? body : (body as { message?: string | string[] }).message;
      const status = exception.getStatus();
      res.status(status).json({ Error: true, Message: Array.isArray(message) ? message.join(", ") : message ?? exception.message, ...(status === 401 ? { SessionExpired: true } : {}) });
    } else {
      this.logger.error(exception instanceof Error ? exception.stack ?? exception.message : String(exception));
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ Error: true, Message: "Export failed." });
    }
  }
}

/** List exports of CI3 (Exports controller): every list page's CSV / Excel / PDF / print, from js/common/export.js. */
@ApiTags("Exports")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(ExportExceptionFilter)
@Controller("api/exports")
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post("exportData")
  @AcceptForm()
  @ApiProduces("application/json", "text/csv", "application/vnd.ms-excel", "application/pdf")
  @ApiOperation({ summary: "Export a list with the page's Filter: csv / excel (.xls) / pdf as a file download; print as { Error, Html }" })
  async exportData(@Body() dto: ExportDataDto, @Res() res: Response): Promise<void> {
    const output = await this.exports.export({
      orgUID: dto.orgId,
      userUID: dto.userId,
      branchUID: dto.branchId,
      moduleUID: parseInt(String(dto.moduleUID ?? ""), 10) || 0,
      format: String(dto.format ?? ""),
      filter: dto.Filter && typeof dto.Filter === "object" ? dto.Filter : {},
    });
    if (output.kind === "print") {
      res.status(HttpStatus.OK).json({ Error: false, Html: output.html });
      return;
    }
    res.status(HttpStatus.OK).set({
      "Content-Type": output.contentType,
      "Content-Disposition": `attachment; filename="${output.fileName}"`,
      "Access-Control-Expose-Headers": "Content-Disposition",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(output.body);
  }
}
