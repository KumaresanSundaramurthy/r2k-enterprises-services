import { Injectable } from "@nestjs/common";
import { AMOUNT_DECIMALS, BALANCE_FY_START_MONTH } from "../../core/constants";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiFieldValidationError, CiValidationError } from "../../core/response/ci-response";
import { currentFinancialYear } from "../../core/utils/financial-year";
import { postInt, postIntList, postJsonArray, postString, postValue } from "../../core/utils/form-values";
import { phpRound } from "../../common/utils/php-compat";
import { AccountLedgerService } from "../../libraries/account-ledger/account-ledger.service";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { CreditSettingsService } from "../../libraries/credit-settings/credit-settings.service";
import { addressFromPost, BankDetailInput, PartyDetailsService } from "../../libraries/party-details/party-details.service";
import { VendorFormDto } from "./dto/vendor-form.dto";
import { VendorListFilterDto } from "./dto/vendor-list.dto";
import { VendorBillingAddressDto, VendorBulkDeleteDto, VendorIdDto, VendorNoteDto, VendorStatusDto, VendorUpdateDto } from "./dto/vendor-write.dto";
import { UploadedFile, VendorAttachmentService } from "./vendor-attachment.service";
import { VendorCacheService } from "./vendor-cache.service";
import { buildVendorRow, LINKED_CUSTOMER_TABLES, linkedCustomerRow, VENDOR_TABLES, vendorFormValidator } from "./vendor-form";
import { VendorProfileRepository } from "./vendor-profile.repository";
import { VendorTranslationService } from "./vendor-translation.service";
import { VendorsRepository } from "./vendors.repository";

// The list filter posted with a bulk "select all" (JSON string or object), reduced to the known filter keys.
function toListFilter(value: unknown): VendorListFilterDto {
  let raw: Record<string, unknown> = {};
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value) ?? {};
    } catch {
      raw = {};
    }
  } else if (value && typeof value === "object") {
    raw = value as Record<string, unknown>;
  }
  const filter: VendorListFilterDto = {};
  if (raw.SearchAllData) filter.SearchAllData = String(raw.SearchAllData);
  if (raw.IsActive !== undefined && raw.IsActive !== null && raw.IsActive !== "") filter.IsActive = parseInt(String(raw.IsActive), 10) || 0;
  if (raw.BalanceType) filter.BalanceType = raw.BalanceType === "Credit" ? "Credit" : "Debit";
  if (raw.UpdatedByUIDs) filter.UpdatedByUIDs = postIntList(raw, "UpdatedByUIDs");
  return filter;
}

// Signed opening balance: Credit (we owe the vendor) = positive
const signed = (amount: number, type: string | null | undefined) => (type === "Credit" ? amount : -amount);

/** Vendor create / update / delete / status / notes / billing address (CI3 Vendors controller write actions). */
@Injectable()
export class VendorWriteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly vendors: VendorsRepository,
    private readonly profile: VendorProfileRepository,
    private readonly orgSettings: OrgSettingsService,
    private readonly creditSettings: CreditSettingsService,
    private readonly partyDetails: PartyDetailsService,
    private readonly ledger: AccountLedgerService,
    private readonly audit: AuditLogService,
    private readonly cache: VendorCacheService,
    private readonly translations: VendorTranslationService,
    private readonly attachments: VendorAttachmentService
  ) {}

  /**
   * addVendorData — in one transaction: the vendor, bank details, addresses, ledger, opening balance and the
   * customer link (new or existing customer). Afterwards: Tamil text (background), vendor number, images, cache, audit.
   */
  async create(form: VendorFormDto, ctx: WriteContext, files: UploadedFile[] = []) {
    this.validate(form);
    const org = await this.orgSettings.get(ctx.orgUID);

    const row = buildVendorRow(form, ctx, true);
    const typedText = await this.translations.normalizeVendorRow(row);
    const billing = addressFromPost(form, "Bill");
    const shipping = addressFromPost(form, "Ship");
    const typedBilling = await this.translations.normalizeAddress(billing);
    const typedShipping = await this.translations.normalizeAddress(shipping);

    const openingAmount = Number(postValue(form, "DebitCreditAmount", 0)) || 0;
    const openingType = postString(form, "DebitCreditCheck", "Credit") as string;
    const bankDetails = postJsonArray<BankDetailInput>(form, "BankDetailsJSON");
    const linking = postString(form, "CustomerLinkingCheck");
    const linkCustomerUID = postInt(form, "Customers");
    if (linking === "ExistingCustomer" && linkCustomerUID <= 0) throw new CiValidationError("Invalid Customer selected for linking");

    const vendorUID = await this.db.transaction(async (trx) => {
      const uid = await this.vendors.insertVendor(trx, row);
      await this.partyDetails.saveBankDetails(trx, VENDOR_TABLES, uid, bankDetails, ctx);
      await this.partyDetails.saveAddress(trx, VENDOR_TABLES, uid, "Billing", billing, ctx);
      await this.partyDetails.saveAddress(trx, VENDOR_TABLES, uid, "Shipping", shipping, ctx);
      await this.ledger.createForEntity(trx, ctx, "Vendor", uid, {
        name: String(row.Name ?? ""),
        openingBalance: postValue(form, "DebitCreditAmount", 0) as string | number,
        openingBalanceType: openingType,
      });
      if (openingAmount > 0) {
        await this.vendors.saveOpeningBalance(trx, ctx.orgUID, uid, openingAmount, openingType, null, ctx.userUID);
        await this.vendors.saveYearOpening(trx, ctx.orgUID, uid, currentFinancialYear(BALANCE_FY_START_MONTH), openingAmount, openingType, ctx.userUID);
      }

      if (linking === "NewCustomer") {
        const customerUID = await this.vendors.insertLinkedCustomer(trx, linkedCustomerRow(row));
        await this.partyDetails.saveBankDetails(trx, LINKED_CUSTOMER_TABLES, customerUID, bankDetails, ctx);
        await this.partyDetails.saveAddress(trx, LINKED_CUSTOMER_TABLES, customerUID, "Billing", billing, ctx);
        await this.partyDetails.saveAddress(trx, LINKED_CUSTOMER_TABLES, customerUID, "Shipping", shipping, ctx);
        await this.vendors.updateVendor(ctx.orgUID, uid, { CustomerUID: customerUID }, trx);
      } else if (linking === "ExistingCustomer") {
        await this.vendors.updateVendor(ctx.orgUID, uid, { CustomerUID: linkCustomerUID }, trx);
      }
      return uid;
    });

    this.translations.scheduleTamilRows(vendorUID, typedText, { Billing: typedBilling, Shipping: typedShipping }, ctx.userUID);

    const claimed = await this.creditSettings.claimNextVendorNumber(org);
    if (claimed) await this.vendors.updateVendor(ctx.orgUID, vendorUID, { VendorNumber: claimed.claimed });

    await this.attachments.apply(ctx, vendorUID, "", files);
    await this.cache.refresh(ctx.orgUID, vendorUID);

    const name = String(row.Name ?? "");
    await this.audit.log(ctx, {
      action: "CREATE_VENDOR",
      entityType: "Vendor",
      entityUID: vendorUID,
      entityRef: name,
      summary: `Created vendor ${name}`,
      module: "Vendors",
      category: "MASTER",
      newValues: row,
    });

    return {
      Message: "Created Successfully",
      VendorUID: vendorUID,
      VendorName: row.Name,
      VendorArea: row.Area,
      Vendor: this.savedVendor(form, vendorUID, row),
    };
  }

  /**
   * updateVendorData — in one transaction: the vendor, bank details and addresses (with deletions), the ledger,
   * the opening balance (moved by the change in the form's opening amount) and the year snapshot when missing.
   * Afterwards: Tamil text, images, cache (and the vendor's products cache), audit.
   */
  async update(form: VendorUpdateDto, ctx: WriteContext, files: UploadedFile[] = []) {
    this.validate(form);
    const vendorUID = postInt(form, "VendorUID");
    const before = await this.vendors.findDebitCreditRaw(ctx.orgUID, vendorUID);
    if (!before) throw new CiValidationError("Vendor not found.");

    const row = buildVendorRow(form, ctx, false);
    if (postValue(form, "ImageRemoved")) row.Image = null;
    const typedText = await this.translations.normalizeVendorRow(row);
    const billing = addressFromPost(form, "Bill");
    const shipping = addressFromPost(form, "Ship");
    // Translated before the transaction opens, so no rows stay locked during the translation API calls
    const typedBilling = await this.translations.normalizeAddress(billing);
    const typedShipping = await this.translations.normalizeAddress(shipping);

    const newAmount = Number(postValue(form, "DebitCreditAmount", 0)) || 0;
    const newType = postString(form, "DebitCreditCheck", "Credit") as string;
    const newSigned = signed(newAmount, newType);
    const delta = phpRound(newSigned - signed(Number(before.DebitCreditAmount ?? 0), before.DebitCreditType ?? "Credit"), AMOUNT_DECIMALS);
    const financialYear = currentFinancialYear(BALANCE_FY_START_MONTH);

    await this.db.transaction(async (trx) => {
      await this.vendors.updateVendor(ctx.orgUID, vendorUID, row, trx);

      if (String(postValue(form, "delBankDataFlag") ?? "") === "1") {
        await this.partyDetails.softDeleteBankRecords(trx, VENDOR_TABLES, postIntList(form, "delBankData"), ctx);
      }
      await this.partyDetails.saveBankDetails(trx, VENDOR_TABLES, vendorUID, postJsonArray<BankDetailInput>(form, "BankDetailsJSON"), ctx);

      if (String(postValue(form, "delAddrDetailFlag") ?? "") === "1") {
        await this.partyDetails.softDeleteAddresses(trx, VENDOR_TABLES, postIntList(form, "delAddrData"), ctx);
      }
      await this.partyDetails.saveAddress(trx, VENDOR_TABLES, vendorUID, "Billing", billing, ctx);
      await this.partyDetails.saveAddress(trx, VENDOR_TABLES, vendorUID, "Shipping", shipping, ctx);

      await this.ledger.updateForEntity(trx, ctx, "Vendor", vendorUID, { name: String(row.Name ?? ""), openingBalance: newAmount, openingBalanceType: newType });

      // The opening balance row moves by the same difference as the form's opening amount
      const opening = await this.vendors.findOpeningBalance(ctx.orgUID, vendorUID, trx);
      let snapshot = opening
        ? { amount: Number(opening.OpeningBalance ?? 0), type: opening.OpeningBalType ?? "Credit" }
        : { amount: Math.abs(newSigned), type: newSigned >= 0 ? "Credit" : "Debit" };
      if (delta !== 0) {
        const current = opening ? signed(Number(opening.OpeningBalance ?? 0), opening.OpeningBalType) : 0;
        const balanceSigned = phpRound(current + delta, AMOUNT_DECIMALS);
        snapshot = { amount: Math.abs(balanceSigned), type: balanceSigned >= 0 ? "Credit" : "Debit" };
        await this.vendors.saveOpeningBalance(trx, ctx.orgUID, vendorUID, snapshot.amount, snapshot.type, undefined, ctx.userUID);
      }
      // Year-opening snapshot only when this financial year has none yet
      await this.vendors.saveYearOpening(trx, ctx.orgUID, vendorUID, financialYear, snapshot.amount, snapshot.type, ctx.userUID, true);
    });

    this.translations.scheduleTamilRows(vendorUID, typedText, { Billing: typedBilling, Shipping: typedShipping }, ctx.userUID);
    await this.attachments.apply(ctx, vendorUID, postString(form, "VendAttachDeleteUIDs") ?? "", files);
    await this.cache.refresh(ctx.orgUID, vendorUID);
    await this.cache.removeProducts(vendorUID);

    await this.audit.log(ctx, {
      action: "UPDATE_VENDOR",
      entityType: "Vendor",
      entityUID: vendorUID,
      entityRef: String(row.Name ?? ""),
      summary: `Updated vendor ${row.Name ?? ""}`,
      module: "Vendors",
      category: "MASTER",
      oldValues: before,
      newValues: row,
    });
    return { Message: "Updated Successfully", Vendor: this.savedVendor(form, vendorUID, row) };
  }

  // deleteVendorData — soft delete; refused while the vendor has transactions.
  async delete(dto: VendorIdDto, ctx: WriteContext) {
    const vendorUID = postInt(dto, "VendorUID");
    if (!vendorUID) throw new CiValidationError("Vendor Information is Missing to Delete");
    if (await this.vendors.hasTransactions(ctx.orgUID, vendorUID)) throw new CiValidationError("Vendor has existing transactions (Purchase Orders/Payments)");
    const vendor = await this.requireDeletable(ctx.orgUID, vendorUID, "Vendor not found", "Vendor already deleted");

    await this.db.transaction(async (trx) => {
      await this.vendors.softDelete(trx, ctx.orgUID, [vendorUID], ctx.userUID);
      if (vendor.LedgerUID) await this.ledger.deactivateForEntity(trx, ctx, "Vendor", vendorUID, Number(vendor.LedgerUID));
    });

    await this.cache.remove(ctx.orgUID, vendorUID);
    await this.audit.log(ctx, {
      action: "DELETE_VENDOR",
      entityType: "Vendor",
      entityUID: vendorUID,
      entityRef: vendor.EntityName ?? "",
      summary: `Deleted vendor ${vendor.EntityName ?? vendorUID}`,
      module: "Vendors",
      category: "MASTER",
      oldValues: vendor,
    });
    return { Message: "Deleted Successfully" };
  }

  // deleteMultipleVendors — the selected vendors, or every vendor matching the list filter (SelectAll = 1); all or nothing.
  async deleteBulk(dto: VendorBulkDeleteDto, ctx: WriteContext) {
    let vendorUIDs: number[];
    if (postInt(dto, "SelectAll") === 1) {
      vendorUIDs = await this.vendors.findUIDsByFilter(ctx.orgUID, toListFilter(dto.Filter));
    } else {
      if (postValue(dto, "VendorUIDs") === null) throw new CiValidationError("Vendor Information is Missing to Delete");
      vendorUIDs = postIntList(dto, "VendorUIDs");
    }
    if (vendorUIDs.length === 0) throw new CiValidationError("Invalid vendor IDs provided");

    await this.db.transaction(async (trx) => {
      for (const vendorUID of vendorUIDs) {
        if (await this.vendors.hasTransactions(ctx.orgUID, vendorUID)) throw new CiValidationError(`Vendor ID ${vendorUID} has existing transactions`);
        const vendor = await this.requireDeletable(ctx.orgUID, vendorUID, `Vendor ID ${vendorUID} not found`, `Vendor ID ${vendorUID} is already deleted`);
        if (vendor.LedgerUID) await this.ledger.deactivateForEntity(trx, ctx, "Vendor", vendorUID, Number(vendor.LedgerUID));
      }
      await this.vendors.softDelete(trx, ctx.orgUID, vendorUIDs, ctx.userUID);
    });

    for (const vendorUID of vendorUIDs) await this.cache.remove(ctx.orgUID, vendorUID);
    await this.audit.log(ctx, {
      action: "BULK_DELETE_VENDORS",
      entityType: "Vendor",
      entityUID: 0,
      entityRef: vendorUIDs.join(","),
      details: { count: vendorUIDs.length },
      summary: `Bulk deleted ${vendorUIDs.length} vendor(s)`,
      module: "Vendors",
      category: "MASTER",
      oldValues: { deletedUIDs: vendorUIDs },
    });
    return { Message: `${vendorUIDs.length} vendor(s) deleted successfully` };
  }

  // toggleVendorStatus — an inactive vendor is also removed from the purchase-form cache.
  async setStatus(dto: VendorStatusDto, ctx: WriteContext) {
    const vendorUID = postInt(dto, "VendorUID");
    const isActive = postInt(dto, "IsActive");
    if (!vendorUID) throw new CiValidationError("Vendor ID is missing.");
    if (isActive !== 0 && isActive !== 1) throw new CiValidationError("Invalid status value.");

    const updated = await this.vendors.updateVendor(ctx.orgUID, vendorUID, { IsActive: isActive, UpdatedBy: ctx.userUID });
    if (updated === 0) throw new CiValidationError("Vendor not found.");

    if (isActive === 1) await this.cache.refresh(ctx.orgUID, vendorUID);
    else await this.cache.remove(ctx.orgUID, vendorUID);

    await this.audit.log(ctx, {
      action: "TOGGLE_VENDOR_STATUS",
      entityType: "Vendor",
      entityUID: vendorUID,
      details: { isActive },
      summary: `${isActive ? "Activated" : "Deactivated"} vendor #${vendorUID}`,
      module: "Vendors",
      category: "MASTER",
      oldValues: { IsActive: 1 - isActive },
      newValues: { IsActive: isActive },
    });
    return { Message: "Status updated successfully." };
  }

  // saveVendorNote
  async addNote(dto: VendorNoteDto, ctx: WriteContext) {
    const vendorUID = postInt(dto, "VendorUID");
    const note = (postString(dto, "Note") ?? "").trim();
    if (vendorUID <= 0) throw new CiValidationError("Invalid vendor.");
    if (!note) throw new CiValidationError("Note cannot be empty.");
    if (!(await this.vendors.findDebitCreditRaw(ctx.orgUID, vendorUID))) throw new CiValidationError("Vendor not found.");
    await this.profile.insertNote(ctx.orgUID, vendorUID, note, ctx.userUID);
    return { Message: "Note saved." };
  }

  // updateBillingAddress — inline billing-address edit from the purchase forms (Tamil input stored in English).
  async updateBillingAddress(dto: VendorBillingAddressDto, ctx: WriteContext) {
    const vendorUID = postInt(dto, "VendorUID");
    const text = (key: string) => String(postValue(dto, key, "") ?? "").trim();
    if (vendorUID <= 0 || text("Line1") === "") throw new CiValidationError("Line 1 is required.");
    if (!(await this.vendors.findDebitCreditRaw(ctx.orgUID, vendorUID))) throw new CiValidationError("Vendor not found.");

    const address = { line1: text("Line1"), line2: text("Line2"), cityText: text("CityText"), stateText: text("StateText") };
    const typed = await this.translations.normalizeAddress(address);
    await this.vendors.saveBillingAddress(
      await this.vendors.findBillingAddressUID(ctx.orgUID, vendorUID),
      {
        VendorUID: vendorUID,
        OrgUID: ctx.orgUID,
        AddressType: "Billing",
        Line1: address.line1,
        Line2: address.line2,
        Pincode: text("Pincode"),
        // Integer columns: an empty id is stored as NULL (CI3 sends '' and fails under the server's strict mode)
        State: text("StateId") || null,
        StateText: address.stateText,
        City: text("CityId") || null,
        CityText: address.cityText,
        UpdatedBy: ctx.userUID,
      },
      ctx.userUID
    );

    this.translations.scheduleAddressRows(vendorUID, { Billing: typed }, ctx.userUID);
    await this.cache.refresh(ctx.orgUID, vendorUID);
    return { Message: "Address updated successfully." };
  }

  private async requireDeletable(orgUID: number, vendorUID: number, notFound: string, alreadyDeleted: string) {
    const vendor = await this.vendors.findWithLedger(orgUID, vendorUID);
    if (!vendor) throw new CiValidationError(notFound);
    if (Number(vendor.IsDeleted) === 1) throw new CiValidationError(alreadyDeleted);
    return vendor;
  }

  private validate(form: VendorFormDto): void {
    const errors = vendorFormValidator.validate(form as unknown as Record<string, unknown>);
    if (Object.keys(errors).length > 0) throw new CiFieldValidationError(errors);
  }

  // The saved vendor for the purchase-form picker: { VendorUID, Name, Area, MobileNumber, Address: [billing] }
  private savedVendor(form: VendorFormDto, vendorUID: number, row: Record<string, unknown>) {
    const trimmed = (key: string) => String(postValue(form, key, "") ?? "").trim();
    return {
      VendorUID: vendorUID,
      Name: String(row.Name ?? "").trim(),
      Area: String(row.Area ?? "").trim(),
      MobileNumber: trimmed("MobileNumber"),
      Address: trimmed("BillAddrLine1")
        ? [
            {
              AddressType: "Billing",
              Line1: trimmed("BillAddrLine1"),
              Line2: trimmed("BillAddrLine2"),
              Pincode: trimmed("BillAddrPincode"),
              CityText: trimmed("BillAddrCityText"),
              StateText: trimmed("BillAddrStateText"),
            },
          ]
        : [],
    };
  }
}
