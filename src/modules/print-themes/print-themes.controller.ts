import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto, OrgPagedListDto } from "../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptForm } from "../products/product-files";
import { PrintThemesService } from "./print-themes.service";

export class ThemeByTypeDto extends OrgContextDto {
  @ApiProperty({ description: "Transaction type name (e.g. Invoice, Payment, Quotation)" }) @Allow() transactionType?: string;
}

export class PrintListDto extends OrgPagedListDto {
  @ApiPropertyOptional({ description: "1-based page number (default 1)" }) @Allow() PageNo?: string | number;
}

export class TemplateListDto extends PrintListDto {
  @ApiPropertyOptional({ description: "Matches the template name" }) @Allow() Search?: string;
}

export class ThemeQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() ThemeConfigUID?: string | number;
}

export class TemplateQueryDto extends OrgContextDto {
  @ApiProperty({ type: Number }) @Allow() TemplateUID?: string | number;
}

export class ThemeIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() ThemeConfigUID?: string | number;
}

export class TemplateIdDto extends OrgUserContextDto {
  @ApiProperty({ type: Number }) @Allow() TemplateUID?: string | number;
}

// The CI3 theme form, field for field
export class ThemeFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add (one theme per transaction type)" }) @Allow() ThemeConfigUID?: string | number;
  @ApiProperty({ description: "Module Name of a printable module (see TransactionTypes)" }) @Allow() TransactionType?: string;
  @ApiPropertyOptional({ description: "Template the theme uses; its key becomes the ThemeKey" }) @Allow() TemplateUID?: string | number;
  @ApiPropertyOptional({ description: "Used when no TemplateUID (default classic)" }) @Allow() ThemeKey?: string;
  @ApiPropertyOptional({ example: "#1a3c6e" }) @Allow() PrimaryColor?: string;
  @ApiPropertyOptional({ example: "#f59e0b" }) @Allow() AccentColor?: string;
  @ApiPropertyOptional() @Allow() ShowLogo?: string | number;
  @ApiPropertyOptional() @Allow() ShowOrgAddress?: string | number;
  @ApiPropertyOptional() @Allow() ShowGSTIN?: string | number;
  @ApiPropertyOptional() @Allow() ShowHSN?: string | number;
  @ApiPropertyOptional() @Allow() ShowTaxBreakdown?: string | number;
  @ApiPropertyOptional() @Allow() ShowPartyBalance?: string | number;
  @ApiPropertyOptional() @Allow() ShowTime?: string | number;
  @ApiPropertyOptional({ example: "Arial" }) @Allow() FontFamily?: string;
  @ApiPropertyOptional({ description: "8–20 (default 11)" }) @Allow() FontSizePx?: string | number;
}

// The CI3 template form (templates are global, shared by every organisation)
export class TemplateFormDto extends OrgUserContextDto {
  @ApiPropertyOptional({ description: "0 / empty = add" }) @Allow() TemplateUID?: string | number;
  @ApiProperty() @Allow() TemplateName?: string;
  @ApiPropertyOptional({ description: "Lower-case letters, digits and _ (built from the name when empty)" }) @Allow() TemplateKey?: string;
  @ApiPropertyOptional({ enum: ["general", "gst", "minimal", "formal", "modern"] }) @Allow() Category?: string;
  @ApiPropertyOptional() @Allow() Description?: string;
  @ApiPropertyOptional() @Allow() HtmlContent?: string;
  @ApiPropertyOptional() @Allow() PreviewHtmlContent?: string;
  @ApiPropertyOptional() @Allow() PreviewImage?: string;
  @ApiPropertyOptional() @Allow() SortOrder?: string | number;
}

const pageOf = (dto: PrintListDto) => Math.max(1, postInt(dto, "PageNo") || 1);

/* Public (no JWT) — CI3 Doc / Pay / Receipt and Transactions_model PDF functions call this
   server-to-server without a user JWT cookie. */
@ApiTags("Print Templates")
@UseFilters(CiExceptionFilter)
@Controller("api/printthemes")
export class PrintThemesPublicController {
  constructor(private readonly themes: PrintThemesService) {}

  @Get("getPrintThemeByType")
  @ApiOperation({ summary: "Theme config + template HTML/preview for a transaction type (no JWT — used by Doc, Transactions_model PDF, etc.)" })
  async getPrintThemeByType(@Query() dto: ThemeByTypeDto) {
    return ciSuccess(await this.themes.getThemeByType(dto.orgId, String(dto.transactionType ?? "")));
  }
}

// Settings → Print Templates page of CI3 (Printthemes controller), same method names as its JS calls.
@ApiTags("Print Templates")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/printthemes")
export class PrintThemesController {
  constructor(private readonly themes: PrintThemesService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "Page data: TransactionTypes, TransactionTypeIds, Templates (carousel), UsedTypes, OrgPreviewData" })
  async getPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.themes.getPageData(dto.orgId));
  }

  @Get("getThemeList")
  @ApiOperation({ summary: "Themes tab page (Data, TotalCount, PageNo, RowLimit, TransactionTypes)" })
  async getThemeList(@Query() dto: PrintListDto) {
    return ciSuccess(await this.themes.getThemes(dto.orgId, pageOf(dto), dto.RowLimit));
  }

  @Get("getTemplateList")
  @ApiOperation({ summary: "Templates tab page (Data, TotalCount, PageNo, RowLimit)" })
  async getTemplateList(@Query() dto: TemplateListDto) {
    return ciSuccess(await this.themes.getTemplates(dto.orgId, pageOf(dto), dto.RowLimit, String(dto.Search ?? "")));
  }

  @Get("getThemeData")
  @ApiOperation({ summary: "One theme (Data)" })
  async getThemeData(@Query() dto: ThemeQueryDto) {
    return ciSuccess(await this.themes.getTheme(dto.orgId, postInt(dto, "ThemeConfigUID")));
  }

  @Get("getTemplateData")
  @ApiOperation({ summary: "One template with its HTML (Data)" })
  async getTemplateData(@Query() dto: TemplateQueryDto) {
    return ciSuccess(await this.themes.getTemplate(postInt(dto, "TemplateUID")));
  }

  @Post("saveTheme")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update the theme of a transaction type" })
  async saveTheme(@Body() dto: ThemeFormDto, @Req() req: Request) {
    return ciSuccess(await this.themes.saveTheme({ ...dto }, writeContext(dto, req)));
  }

  @Post("deleteTheme")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Remove a theme" })
  async deleteTheme(@Body() dto: ThemeIdDto, @Req() req: Request) {
    return ciSuccess(await this.themes.deleteTheme(postInt(dto, "ThemeConfigUID"), writeContext(dto, req)));
  }

  @Post("saveTemplate")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update a print template (global)" })
  async saveTemplate(@Body() dto: TemplateFormDto) {
    return ciSuccess(await this.themes.saveTemplate({ ...dto }));
  }

  @Post("deleteTemplate")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Remove a print template (global)" })
  async deleteTemplate(@Body() dto: TemplateIdDto) {
    return ciSuccess(await this.themes.deleteTemplate(postInt(dto, "TemplateUID")));
  }

  // ── CI3 legacy aliases of saveTheme / deleteTheme: migrated, hidden from Swagger ──────────

  @Post("save")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async save(@Body() dto: ThemeFormDto, @Req() req: Request) {
    return this.saveTheme(dto, req);
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiExcludeEndpoint()
  async delete(@Body() dto: ThemeIdDto, @Req() req: Request) {
    return this.deleteTheme(dto, req);
  }
}
