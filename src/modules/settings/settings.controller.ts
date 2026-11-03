import { applyDecorators, Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserContextDto } from "../../core/dto/write-context.dto";
import { writeContext } from "../../core/request/write-context";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";
import { postInt } from "../../core/utils/form-values";
import { AcceptForm } from "../products/product-files";
import { ClaimsRequest, sessionKeyOf } from "../session-sync/session-sync.service";
import { AdditionalChargesService } from "./additional-charges.service";
import { BankAccountsService } from "./bank-accounts.service";
import {
  BankFormDto,
  BankIdDto,
  BankQueryDto,
  ChargeFormDto,
  ChargeIdDto,
  FundTransferDto,
  GeneralSettingsFormDto,
  MessageTemplateFormDto,
  MessageTemplateIdDto,
  MessageTemplateQueryDto,
  PrefixFormDto,
  PrefixIdDto,
  ProductSettingsFormDto,
  ThermalConfigFormDto,
  ThermalConfigIdDto,
  TransactionSettingsFormDto,
} from "./dto/settings.dto";
import { GeneralSettingsService } from "./general-settings.service";
import { PrintConfigService } from "./print-config.service";

// Every Settings controller: CI3 JWT, CI3 response format, under /api/settings like the CI3 URLs
const SettingsController = (tag: string) =>
  applyDecorators(ApiTags(tag), ApiBearerAuth(), UseGuards(CiJwtGuard), UseFilters(CiExceptionFilter), Controller("api/settings"));

// Settings → General Settings
@SettingsController("Settings: General")
export class GeneralSettingsController {
  constructor(private readonly settings: GeneralSettingsService) {}

  @Get("generalsettings")
  @ApiOperation({ summary: "Page data: GenSettings, ProdSettings, TransSettings and the product-setting dropdowns" })
  async generalsettings(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.settings.getPageData(dto.orgId));
  }

  @Get("getSalutationList")
  @ApiOperation({ summary: "Salutations (Data)" })
  async getSalutationList() {
    return ciSuccess(await this.settings.getSalutations());
  }

  @Post("updateGeneralSettings")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save general settings; refreshes the session's GenSettings" })
  async updateGeneralSettings(@Body() dto: GeneralSettingsFormDto, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.settings.updateGeneral({ ...dto }, writeContext(dto, req), sessionKeyOf(req)));
  }

  @Post("updateProductSettings")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save product-form defaults; refreshes the session's ProdSettings" })
  async updateProductSettings(@Body() dto: ProductSettingsFormDto, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.settings.updateProduct({ ...dto }, writeContext(dto, req), sessionKeyOf(req)));
  }

  @Post("updateTransactionSettings")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Save transaction settings; refreshes the session's TransSettings" })
  async updateTransactionSettings(@Body() dto: TransactionSettingsFormDto, @Req() req: ClaimsRequest) {
    return ciSuccess(await this.settings.updateTransaction({ ...dto }, writeContext(dto, req), sessionKeyOf(req)));
  }
}

// Settings → Bank Accounts
@SettingsController("Settings: Bank Accounts")
export class BankAccountsController {
  constructor(private readonly banks: BankAccountsService) {}

  @Get("getBankList")
  @ApiOperation({ summary: "Bank and cash accounts (Data, TotalCount)" })
  async getBankList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.banks.getList(dto.orgId));
  }

  @Get("getBankBalance")
  @ApiOperation({ summary: "Current balance of an account (Balance)" })
  async getBankBalance(@Query() dto: BankQueryDto) {
    return ciSuccess(await this.banks.getBalance(dto.orgId, postInt(dto, "BankAccountUID")));
  }

  @Get("getBankDetail")
  @ApiOperation({ summary: "One account for the edit form (Data)" })
  async getBankDetail(@Query() dto: BankQueryDto) {
    return ciSuccess(await this.banks.getDetail(dto.orgId, postInt(dto, "BankAccountUID")));
  }

  @Post("saveBankDetail")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update a bank account (a new one also gets its accounting ledger)" })
  async saveBankDetail(@Body() dto: BankFormDto, @Req() req: Request) {
    return ciSuccess(await this.banks.save({ ...dto }, writeContext(dto, req)));
  }

  @Post("deleteBankDetail")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a bank account (not the cash account)" })
  async deleteBankDetail(@Body() dto: BankIdDto, @Req() req: Request) {
    return ciSuccess(await this.banks.delete(postInt(dto, "BankAccountUID"), writeContext(dto, req)));
  }

  @Post("setDefaultBank")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Make an account the default" })
  async setDefaultBank(@Body() dto: BankIdDto, @Req() req: Request) {
    return ciSuccess(await this.banks.setDefault(postInt(dto, "BankAccountUID"), writeContext(dto, req)));
  }

  @Post("transferFunds")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Transfer between accounts (posts the contra journal and the bank-book lines)" })
  async transferFunds(@Body() dto: FundTransferDto, @Req() req: Request) {
    return ciSuccess(await this.banks.transfer({ ...dto }, writeContext(dto, req)));
  }
}

// Settings → Templates (message templates)
@SettingsController("Settings: Message Templates")
export class MessageTemplatesController {
  constructor(private readonly config: PrintConfigService) {}

  @Get("getMsgTemplateList")
  @ApiOperation({ summary: "Templates with the module map and the tokens (Data, TotalCount, Modules, Tokens)" })
  async getMsgTemplateList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.config.getMessageTemplates(dto.orgId));
  }

  @Get("getMsgTemplateDetail")
  @ApiOperation({ summary: "One template (Data)" })
  async getMsgTemplateDetail(@Query() dto: MessageTemplateQueryDto) {
    return ciSuccess(await this.config.getMessageTemplate(dto.orgId, postInt(dto, "TemplateUID")));
  }

  @Post("saveMsgTemplate")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update a template (returns the list)" })
  async saveMsgTemplate(@Body() dto: MessageTemplateFormDto, @Req() req: Request) {
    return ciSuccess(await this.config.saveMessageTemplate({ ...dto }, writeContext(dto, req)));
  }

  @Post("deleteMsgTemplate")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a template" })
  async deleteMsgTemplate(@Body() dto: MessageTemplateIdDto, @Req() req: Request) {
    return ciSuccess(await this.config.deleteMessageTemplate(postInt(dto, "TemplateUID"), writeContext(dto, req)));
  }
}

// Settings → Thermal Print
@SettingsController("Settings: Thermal Print")
export class ThermalConfigController {
  constructor(private readonly config: PrintConfigService) {}

  @Get("thermalconfig")
  @ApiOperation({ summary: "Page data: configs, UsedTypes, TransTypes, ThermalTypeCount, OrgPreviewData" })
  async thermalconfig(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.config.getThermalPageData(dto.orgId));
  }

  @Get("getThermalConfigList")
  @ApiOperation({ summary: "Configs (Data, UsedTypes, TotalCount, TransTypes)" })
  async getThermalConfigList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.config.getThermalConfigs(dto.orgId));
  }

  @Post("saveThermalConfig")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update the config of a module (returns the list)" })
  async saveThermalConfig(@Body() dto: ThermalConfigFormDto, @Req() req: Request) {
    return ciSuccess(await this.config.saveThermalConfig({ ...dto }, writeContext(dto, req)));
  }

  @Post("deleteThermalConfig")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a config" })
  async deleteThermalConfig(@Body() dto: ThermalConfigIdDto, @Req() req: Request) {
    return ciSuccess(await this.config.deleteThermalConfig(postInt(dto, "ThermalConfigUID"), writeContext(dto, req)));
  }
}

// Settings → Prefix Config
@SettingsController("Settings: Prefix Config")
export class PrefixConfigController {
  constructor(private readonly config: PrintConfigService) {}

  @Get("getPrefixConfigList")
  @ApiOperation({ summary: "Prefixes with the module map (Data, TotalCount, Modules, PrefixModuleCount)" })
  async getPrefixConfigList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.config.getPrefixes(dto.orgId));
  }

  @Post("savePrefixConfig")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update a prefix (returns the list)" })
  async savePrefixConfig(@Body() dto: PrefixFormDto, @Req() req: Request) {
    return ciSuccess(await this.config.savePrefix({ ...dto }, writeContext(dto, req)));
  }

  @Post("deletePrefixConfig")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a prefix (not a module's default)" })
  async deletePrefixConfig(@Body() dto: PrefixIdDto, @Req() req: Request) {
    return ciSuccess(await this.config.deletePrefix(postInt(dto, "prePrefixUID"), writeContext(dto, req)));
  }

  @Post("setDefaultPrefixConfig")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Make a prefix its module's default" })
  async setDefaultPrefixConfig(@Body() dto: PrefixIdDto, @Req() req: Request) {
    return ciSuccess(await this.config.setDefaultPrefix(postInt(dto, "prePrefixUID"), writeContext(dto, req)));
  }
}

// Settings → Additional Charges
@SettingsController("Settings: Additional Charges")
export class AdditionalChargesController {
  constructor(private readonly charges: AdditionalChargesService) {}

  @Get("additionalcharges")
  @ApiOperation({ summary: "Page data (adds the system charges when missing): charges, ChargeCount, ChargeLimit, NextSortOrder, TaxList" })
  async additionalcharges(@Query() dto: OrgUserContextDto) {
    return ciSuccess(await this.charges.getPageData({ orgUID: dto.orgId, userUID: dto.userId }));
  }

  @Get("getAdditionalChargesList")
  @ApiOperation({ summary: "Charges (Data, ChargeCount, ChargeLimit, NextSortOrder)" })
  async getAdditionalChargesList(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.charges.getList(dto.orgId));
  }

  @Get("getAdditionalChargesCache")
  @ApiOperation({ summary: "Cached charge list the transaction forms use (Data)" })
  async getAdditionalChargesCache(@Query() dto: OrgContextDto) {
    return ciSuccess(await this.charges.getCached(dto.orgId));
  }

  @Post("saveAdditionalCharge")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Add / update a charge (returns the list, AllCharges and NewCharge when added)" })
  async saveAdditionalCharge(@Body() dto: ChargeFormDto, @Req() req: Request) {
    return ciSuccess(await this.charges.save({ ...dto }, writeContext(dto, req)));
  }

  @Post("deleteAdditionalCharge")
  @HttpCode(HttpStatus.OK)
  @AcceptForm()
  @ApiOperation({ summary: "Delete a charge (not a system charge or one used in a transaction)" })
  async deleteAdditionalCharge(@Body() dto: ChargeIdDto, @Req() req: Request) {
    return ciSuccess(await this.charges.delete(postInt(dto, "acChargeUID"), writeContext(dto, req)));
  }
}
