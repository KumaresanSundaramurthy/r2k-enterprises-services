import { Injectable } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { toInt } from "../../common/utils/php-compat";
import { BackgroundTaskService } from "../../core/background/background-task.service";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postFlag, postInt } from "../../core/utils/form-values";
import { TranslationService } from "../../libraries/translation/translation.service";
import { ErpSessionContext } from "../../auth/interfaces/erp-session.interface";
import { BranchFormDto, BranchIdDto, BranchListDto, BranchStatusDto } from "./dto/branch.dto";
import { BRANCH_TEXT_FIELDS, BranchesRepository, BranchTextField, Row } from "./branches.repository";

// CI3 Branches controller (Settings → Branches page and the navbar branch switcher).
@Injectable()
export class BranchesService {
  constructor(
    private readonly repo: BranchesRepository,
    private readonly db: DatabaseService,
    private readonly orgSettings: OrgSettingsService,
    private readonly translation: TranslationService,
    private readonly background: BackgroundTaskService,
    private readonly redis: RedisService
  ) {}

  // getPageDetails — one page of branches; the CI3 JS builds the rows and pagination
  async getPage(orgUID: number, pageNo: number, dto: BranchListDto) {
    const rowLimit = await this.orgSettings.resolveRowLimit(orgUID, dto.RowLimit);
    const result = await this.repo.listPaginated(orgUID, rowLimit, BranchesService.offset(pageNo, rowLimit), (dto.Filter?.Search ?? "").trim(), dto.langCode);
    return { Data: result.rows, TotalCount: result.totalCount, PageNo: pageNo, RowLimit: rowLimit };
  }

  // index — branch types for the branch modal
  async getBranchTypes() {
    return { Data: await this.repo.branchTypes() };
  }

  // getList — active branches
  async getList(orgUID: number, langCode: string) {
    return { Data: await this.repo.listActive(orgUID, langCode) };
  }

  // save — create or update; Tamil text is stored in English and the Tamil row is written in the background
  async save(form: BranchFormDto, ctx: WriteContext) {
    const { orgUID, userUID } = ctx;
    let branchUID = postInt(form, "BranchUID");
    const isUpdate = branchUID > 0;

    const typed = {} as Record<BranchTextField, string>;
    const english = {} as Record<BranchTextField, string>;
    for (const field of BRANCH_TEXT_FIELDS) {
      typed[field] = String(form[field] ?? "").trim();
      english[field] = this.translation.detectLang(typed[field]) === "ta" ? await this.translation.translate(typed[field], "ta", "en") : typed[field];
    }
    const code = String(form.BranchCode ?? "").trim().toUpperCase();

    if (!english.Name) throw new CiValidationError("Branch name is required.");
    if (!code) throw new CiValidationError("Branch code is required.");
    if (await this.repo.codeExists(orgUID, code, branchUID)) throw new CiValidationError(`Branch code "${code}" is already in use.`);

    const isHeadOffice = postFlag(form, "IsHeadOffice") === 1;
    const text = (key: keyof BranchFormDto) => String(form[key] ?? "").trim();
    const data: Row = {
      OrgUID: orgUID,
      ...english,
      BranchCode: code,
      BranchTypeUID: postInt(form, "BranchTypeUID") || null,
      MobileNumber: text("MobileNumber"),
      AlternateNumber: text("AlternateNumber"),
      CountryCode: text("CountryCode"),
      CountryISO2: text("CountryISO2"),
      EmailAddress: text("EmailAddress"),
      PANNumber: text("PANNumber").toUpperCase(),
      GSTIN: text("GSTIN").toUpperCase(),
      Pincode: text("Pincode"),
      StateId: text("StateId"),
      CityId: text("CityId"),
      IsWarehouse: postFlag(form, "IsWarehouse"),
      IsDispatchPoint: postFlag(form, "IsDispatchPoint"),
      IsSalesPoint: postFlag(form, "IsSalesPoint"),
      IsServiceCenter: postFlag(form, "IsServiceCenter"),
      IsActive: 1,
      UpdatedBy: userUID,
    };
    // Head office is only ever set here; unsetting it happens by making another branch the head office
    if (isHeadOffice) data.IsHeadOffice = 1;

    await this.db.write.transaction(async (trx) => {
      if (isHeadOffice) await this.repo.clearHeadOffice(orgUID, userUID, trx);
      if (isUpdate) await this.repo.update(orgUID, branchUID, data, trx);
      else branchUID = await this.repo.insert({ ...data, CreatedBy: userUID }, trx);
    });

    this.scheduleTamilRow(branchUID, typed, english, userUID);
    return { Message: isUpdate ? "Branch updated." : "Branch created." };
  }

  // toggleStatus — IsActive is the current status, which is flipped
  async toggleStatus(dto: BranchStatusDto, ctx: WriteContext) {
    const branchUID = postInt(dto, "BranchUID");
    if (!branchUID) throw new CiValidationError("Invalid branch.");
    const newStatus = postInt(dto, "IsActive") === 1 ? 0 : 1;
    await this.repo.update(ctx.orgUID, branchUID, { IsActive: newStatus, UpdatedBy: ctx.userUID });
    return { Message: newStatus ? "Branch activated." : "Branch deactivated." };
  }

  // delete — soft delete, refused while the branch has records
  async delete(dto: BranchIdDto, ctx: WriteContext) {
    const branchUID = postInt(dto, "BranchUID");
    if (!branchUID) throw new CiValidationError("Invalid branch.");
    if (await this.repo.hasLinkedRecords(branchUID, ctx.orgUID)) {
      throw new CiValidationError("This branch cannot be deleted because it has linked transactions or records.");
    }
    await this.repo.update(ctx.orgUID, branchUID, { IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    return { Message: "Branch deleted." };
  }

  // setHeadOffice — the only head office of the organisation
  async setHeadOffice(dto: BranchIdDto, ctx: WriteContext) {
    const branchUID = postInt(dto, "BranchUID");
    if (!branchUID) throw new CiValidationError("Invalid branch.");
    await this.db.write.transaction(async (trx) => {
      await this.repo.clearHeadOffice(ctx.orgUID, ctx.userUID, trx);
      await this.repo.update(ctx.orgUID, branchUID, { IsHeadOffice: 1, UpdatedBy: ctx.userUID }, trx);
    });
    return { Message: "Head office updated successfully." };
  }

  // switchBranch — changes the active branch in the logged-in session (one of the user's accessible branches)
  async switchBranch(branchUID: number, session: ErpSessionContext) {
    if (!branchUID) throw new CiValidationError("Invalid branch.");
    const org = session.data.Org;
    const accessible = (org.AccessibleBranches as Row[] | undefined) ?? [];
    const target = accessible.find((branch) => toInt(branch.BranchUID) === branchUID);
    if (!target) throw new CiValidationError("You do not have access to this branch.");
    if (toInt(org.BranchUID) === branchUID) return { Message: "Already on this branch." };

    const branchName = String(target.BranchName ?? "");
    const branchCode = String(target.BranchCode ?? "");
    const payload = { ...session.data, Org: { ...org, BranchUID: branchUID, BranchName: branchName, BranchCode: branchCode } };
    await this.redis.set(session.key, payload, Number(process.env.LOGIN_EXPIRE_SECS) || 7200);
    return { Message: `Switched to ${branchName}`, BranchUID: branchUID, BranchName: branchName, BranchCode: branchCode };
  }

  // _triggerBranchLangSave — the language is taken from the name: Tamil input is kept, English is translated
  private scheduleTamilRow(branchUID: number, typed: Record<BranchTextField, string>, english: Record<BranchTextField, string>, userUID: number): void {
    const typedTamil = this.translation.detectLang(typed.Name) === "ta";
    this.background.run(`Tamil text for branch ${branchUID}`, async () => {
      const tamil = {} as Record<BranchTextField, string | null>;
      for (const field of BRANCH_TEXT_FIELDS) {
        tamil[field] = (typedTamil ? typed[field] : await this.translation.translate(english[field], "en", "ta")) || null;
      }
      await this.repo.saveLangRow(branchUID, "ta", tamil, userUID);
    });
  }

  private static offset(pageNo: number, limit: number): number {
    return Math.max(0, (pageNo - 1) * limit);
  }
}
