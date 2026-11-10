import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { AcceptForm } from "../products/product-files";
import { BarcodeConfigService } from "./barcode-config.service";

export class SaveCodeConfigDto extends OrgUserContextDto {
  @ApiProperty({ enum: ["barcode", "qrcode"] }) @Allow() ConfigType?: string;
  @ApiPropertyOptional({ example: "CODE128", description: "barcode" }) @Allow() Format?: string;
  @ApiPropertyOptional({ example: 2, description: "barcode" }) @Allow() BarWidth?: string | number;
  @ApiPropertyOptional({ example: 60, description: "barcode" }) @Allow() Height?: string | number;
  @ApiPropertyOptional({ example: 1, description: "barcode: 1 = show the value under the bars" }) @Allow() ShowValue?: string | number;
  @ApiPropertyOptional({ example: 11, description: "barcode" }) @Allow() FontSize?: string | number;
  @ApiPropertyOptional({ example: "#000000", description: "barcode" }) @Allow() LineColor?: string;
  @ApiPropertyOptional({ example: 100, description: "qrcode" }) @Allow() Size?: string | number;
  @ApiPropertyOptional({ example: "M", description: "qrcode: L / M / Q / H" }) @Allow() ErrorLevel?: string;
  @ApiPropertyOptional({ example: "#000000", description: "qrcode" }) @Allow() DarkColor?: string;
  @ApiPropertyOptional({ example: "#ffffff", description: "qrcode" }) @Allow() LightColor?: string;
  @ApiPropertyOptional({ example: 1, description: "1 = enabled" }) @Allow() IsEnabled?: string | number;
}

export class LayoutQueryDto extends OrgContextDto {
  @ApiPropertyOptional({ enum: ["barcode", "qrcode"], default: "barcode" }) @Allow() type?: string;
}

export class SaveLayoutDto extends OrgUserContextDto {
  @ApiProperty({ enum: ["barcode", "qrcode"] }) @Allow() LabelType?: string;
  @ApiPropertyOptional({ example: "50x25" }) @Allow() LabelSizeKey?: string;
  @ApiPropertyOptional({ example: 189 }) @Allow() LabelWidthPx?: string | number;
  @ApiPropertyOptional({ example: 94 }) @Allow() LabelHeightPx?: string | number;
  @ApiProperty({ description: "JSON array of the label's fields with position and style" }) @Allow() FieldsLayout?: string;
}

// Settings → Barcode / QR code page of CI3 (Barcodeconfig controller)
@ApiTags("Barcode Config")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/barcodeconfig")
export class BarcodeConfigController {
  constructor(private readonly barcode: BarcodeConfigService) {}

  @Get("getPageData")
  @ApiOperation({ summary: "Page data (Barcodeconfig::index): BarcodeConfig and QRConfig, with defaults when not saved" })
  async getPageData(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.barcode.getPageData(dto.orgId));
  }

  @Post("saveConfig")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Save the barcode or QR code settings (insert or update)" })
  async saveConfig(@Body() dto: SaveCodeConfigDto) {
    return ciSuccess(await this.barcode.saveConfig(dto.orgId, dto.userId, { ...dto }));
  }

  @Get("getLayout")
  @ApiOperation({ summary: "Saved label layout: {Layout} (null when none); needs Products.BarcodeLabelLayoutTbl" })
  async getLayout(@Query() dto: LayoutQueryDto) {
    return ciSuccess(await this.barcode.getLayout(dto.orgId, dto.type));
  }

  @Post("saveLayout")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiConsumes("multipart/form-data", "application/json")
  @ApiOperation({ summary: "Save the label layout (insert or update); needs Products.BarcodeLabelLayoutTbl" })
  async saveLayout(@Body() dto: SaveLayoutDto) {
    return ciSuccess(await this.barcode.saveLayout(dto.orgId, dto.userId, { ...dto }));
  }
}
