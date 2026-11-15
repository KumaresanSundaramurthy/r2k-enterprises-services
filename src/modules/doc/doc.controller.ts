import { Controller, Get, HttpStatus, Param, Res, UseFilters } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciError, ciSuccess } from "../../core/response/ci-response";
import { DocService } from "./doc.service";

/**
 * Public (no JWT) — the shared document link. CI3 Doc::view / Doc::pdf call these with the link's TransToken;
 * the token itself is the access check.
 */
@ApiTags("Public document")
@UseFilters(CiExceptionFilter)
@Controller("api/doc")
export class DocController {
  constructor(private readonly docs: DocService) {}

  @Get(":token")
  @ApiParam({ name: "token", description: "The document's TransToken" })
  @ApiOperation({ summary: "Shared document: Stub (ModuleUID, DocStatus, TransType, UniqueNumber, NetAmount, PaidAmount, BalanceAmount) and PrintHtml. Drafts are refused." })
  async view(@Param("token") token: string) {
    return ciSuccess(await this.docs.view(String(token ?? "").trim()));
  }

  @Get(":token/pdf")
  @ApiParam({ name: "token", description: "The document's TransToken" })
  @ApiOperation({ summary: "Shared document as an A4 PDF download (404 JSON when the link is invalid, deleted or a draft)" })
  async pdf(@Param("token") token: string, @Res() res: Response) {
    const pdf = await this.docs.pdf(String(token ?? "").trim());
    if (!pdf) {
      res.status(HttpStatus.NOT_FOUND).json(ciError("Document not found."));
      return;
    }
    res
      .status(HttpStatus.OK)
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdf.filename}"`,
        "Content-Length": String(pdf.bytes.length),
        "Cache-Control": "private, max-age=0, must-revalidate",
      })
      .end(pdf.bytes);
  }
}
