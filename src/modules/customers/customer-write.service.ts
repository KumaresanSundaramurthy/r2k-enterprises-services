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
import { CustomerBalanceService } from "../../libraries/customer-balance/customer-balance.service";
import { BankDetailInput, PartyDetailsService } from "../../libraries/party-details/party-details.service";
import { CustomerListFilterDto } from "./dto/customer-list.dto";
import {
  BillingAddressDto,
  CustomerBulkDeleteDto,
  CustomerIdDto,
  CustomerNoteDto,
  CustomerStatusDto,
  CustomerUpdateDto,
} from "./dto/customer-write.dto";
import { CustomerAttachmentService, UploadedFile } from "./customer-attachment.service";
import { CustomerCacheService } from "./customer-cache.service";
import { addressFromForm, buildCustomerRow, CUSTOMER_TABLES } from "./customer-form.mapper";
import { customerFormValidator } from "./customer-form.validator";
import { CustomerTranslationService } from "./customer-translation.service";
import { CustomerFormDto } from "./dto/customer-form.dto";
import { CustomersRepository } from "./customers.repository";
import { CustomersService } from "./customers.service";

// The list filter posted with a bulk "select all" (object or JSON string), reduced to the known filter keys.
function toListFilter(value: unknown): CustomerListFilterDto {
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
  const filter: CustomerListFilterDto = {};
  if (raw.SearchAllData) filter.SearchAllData = String(raw.SearchAllData);
  if (raw.Tags) filter.Tags = ([] as unknown[]).concat(raw.Tags).map(String);
  if (raw.CustomerTypeUIDs) filter.CustomerTypeUIDs = postIntList(raw, "CustomerTypeUIDs");
  if (raw.BalanceType) filter.BalanceType = raw.BalanceType === "Credit" ? "Credit" : "Debit";
  if (raw.IsActive !== undefined && raw.IsActive !== null && raw.IsActive !== "") filter.IsActive = parseInt(String(raw.IsActive), 10) || 0;
  return filter;
}

/** Customer create / update / delete / status (CI3 Customers controller write actions). */
@Injectable()
export class CustomerWriteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly customers: CustomersRepository,
    private readonly customersRead: CustomersService,
    private readonly orgSettings: OrgSettingsService,
    private readonly creditSettings: CreditSettingsService,
    private readonly partyDetails: PartyDetailsService,
    private readonly ledger: AccountLedgerService,
    private readonly audit: AuditLogService,
    private readonly cache: CustomerCacheService,
    private readonly translations: CustomerTranslationService,
    private readonly customerBalance: CustomerBalanceService,
    private readonly attachments: CustomerAttachmentService
  ) {}

  /**
   * addCustomerData — in one transaction: the customer, bank details, addresses, ledger and opening
   * balance. Afterwards: customer number, Tamil text (background), cache, group membership and audit.
   */
  async create(form: CustomerFormDto, ctx: WriteContext, files: UploadedFile[] = []) {
    this.validate(form);
    const org = await this.orgSettings.get(ctx.orgUID);

    const row = buildCustomerRow(form, ctx, true);
    const typedText = await this.translations.normalizeCustomerRow(row);
    const billing = addressFromForm(form, "Bill");
    const shipping = addressFromForm(form, "Ship");
    const typedBilling = await this.translations.normalizeAddress(billing);
    const typedShipping = await this.translations.normalizeAddress(shipping);

    const openingAmount = Number(postValue(form, "DebitCreditAmount", 0)) || 0;
    const openingType = postString(form, "DebitCreditCheck", "Debit") as string;

    const customerUID = await this.db.transaction(async (trx) => {
      const uid = await this.customers.insertCustomer(trx, row);
      await this.partyDetails.saveBankDetails(trx, CUSTOMER_TABLES, uid, postJsonArray<BankDetailInput>(form, "BankDetailsJSON"), ctx);
      await this.partyDetails.saveAddress(trx, CUSTOMER_TABLES, uid, "Billing", billing, ctx);
      await this.partyDetails.saveAddress(trx, CUSTOMER_TABLES, uid, "Shipping", shipping, ctx);
      await this.ledger.createForEntity(trx, ctx, "Customer", uid, {
        name: postString(form, "Name") ?? "",
        openingBalance: postValue(form, "DebitCreditAmount", 0) as string | number,
        openingBalanceType: openingType,
      });
      if (openingAmount > 0) {
        await this.customers.saveOpeningBalance(trx, ctx.orgUID, uid, openingAmount, openingType, null, ctx.userUID, true);
        await this.customers.saveYearOpening(
          trx,
          ctx.orgUID,
          uid,
          currentFinancialYear(BALANCE_FY_START_MONTH),
          openingAmount,
          openingType,
          ctx.userUID,
          { isNew: true }
        );
      }
      return uid;
    });

    this.translations.scheduleTamilRows(customerUID, typedText, { Billing: typedBilling, Shipping: typedShipping }, ctx.userUID);

    const claimed = await this.creditSettings.claimNextCustomerNumber(org);
    if (claimed) await this.customers.updateCustomer(customerUID, { CustomerNumber: claimed.claimed });

    await this.attachments.apply(ctx, customerUID, postString(form, "CustAttachDeleteUIDs") ?? "", files);
    await this.cache.refresh(ctx.orgUID, org.OrgToken, customerUID);

    await this.syncGroupMembership(ctx, customerUID, postInt(form, "GroupUID"));

    const name = postString(form, "Name") ?? "";
    await this.audit.log(ctx, {
      action: "CREATE_CUSTOMER",
      entityType: "Customer",
      entityUID: customerUID,
      entityRef: name,
      summary: `Created customer ${name}`,
      module: "Customers",
      category: "MASTER",
      newValues: row,
    });

    return {
      Message: "Created Successfully",
      Customer: this.dropdownEntry(form, customerUID),
      ...(await this.listIfRequested(form, ctx.orgUID)),
    };
  }

  /**
   * updateCustomerData — in one transaction: the customer, bank details and addresses (with deletions),
   * the ledger (on name or opening-balance change) and the opening balance. Afterwards: balance recalculation
   * (when the opening balance changed), Tamil text, cache, group membership and audit.
   */
  async update(form: CustomerUpdateDto, ctx: WriteContext, files: UploadedFile[] = []) {
    // CustomerUID is always validated on update ("The Customer UID field is required.")
    if (!Object.prototype.hasOwnProperty.call(form, "CustomerUID")) form.CustomerUID = "";
    this.validate(form);
    const customerUID = postInt(form, "CustomerUID");
    const before = await this.customers.findDebitCreditRaw(ctx.orgUID, customerUID);
    if (!before) throw new CiValidationError("Customer not found.");
    const org = await this.orgSettings.get(ctx.orgUID);

    const row = buildCustomerRow(form, ctx, false);
    if (postValue(form, "ImageRemoved")) row.Image = null;
    const typedText = await this.translations.normalizeCustomerRow(row);
    const billing = addressFromForm(form, "Bill");
    const shipping = addressFromForm(form, "Ship");
    // Translated before the transaction opens, so no rows stay locked during the translation API calls
    const typedBilling = await this.translations.normalizeAddress(billing);
    const typedShipping = await this.translations.normalizeAddress(shipping);

    const newAmount = Number(postValue(form, "DebitCreditAmount", 0)) || 0;
    const newType = postString(form, "DebitCreditCheck", "Debit") as string;
    const newSigned = newType === "Debit" ? newAmount : -newAmount;
    // CustOpeningBalanceTbl is the source of truth for the opening balance (CustomerTbl can be stale)
    const openingBefore = await this.customers.findOpeningBalance(ctx.orgUID, customerUID);
    const oldSigned = openingBefore
      ? (openingBefore.OpeningBalType === "Debit" ? 1 : -1) * Number(openingBefore.OpeningBalance)
      : 0;
    const balanceChanged = phpRound(newSigned - oldSigned, AMOUNT_DECIMALS) !== 0;
    const nameChanged = row.Name !== before.Name;

    await this.db.transaction(async (trx) => {
      await this.customers.updateCustomer(customerUID, row, trx);

      if (String(postValue(form, "delBankDataFlag") ?? "") === "1") {
        await this.partyDetails.softDeleteBankRecords(trx, CUSTOMER_TABLES, postIntList(form, "delBankData"), ctx);
      }
      await this.partyDetails.saveBankDetails(trx, CUSTOMER_TABLES, customerUID, postJsonArray<BankDetailInput>(form, "BankDetailsJSON"), ctx);

      if (String(postValue(form, "delAddrDetailFlag") ?? "") === "1") {
        await this.partyDetails.softDeleteAddresses(trx, CUSTOMER_TABLES, postIntList(form, "delAddrData"), ctx);
      }
      await this.partyDetails.saveAddress(trx, CUSTOMER_TABLES, customerUID, "Billing", billing, ctx);
      await this.partyDetails.saveAddress(trx, CUSTOMER_TABLES, customerUID, "Shipping", shipping, ctx);

      if (nameChanged || balanceChanged) {
        await this.ledger.updateForEntity(trx, ctx, "Customer", customerUID, {
          name: String(row.Name ?? ""),
          openingBalance: newAmount,
          openingBalanceType: newType,
        });
      }
      if (balanceChanged) {
        const balance = Math.abs(newSigned);
        const balanceType = newSigned >= 0 ? "Debit" : "Credit";
        await this.customers.saveOpeningBalance(trx, ctx.orgUID, customerUID, balance, balanceType, undefined, ctx.userUID, false);
        await this.customers.saveYearOpening(
          trx,
          ctx.orgUID,
          customerUID,
          currentFinancialYear(BALANCE_FY_START_MONTH),
          balance,
          balanceType,
          ctx.userUID
        );
      }
    });

    this.translations.scheduleTamilRows(customerUID, typedText, { Billing: typedBilling, Shipping: typedShipping }, ctx.userUID);
    // After commit, so the recalculation reads the new opening balance
    if (balanceChanged) await this.customerBalance.recalcAndSync(ctx.orgUID, customerUID, ctx.userUID);
    await this.attachments.apply(ctx, customerUID, postString(form, "CustAttachDeleteUIDs") ?? "", files);
    await this.cache.refresh(ctx.orgUID, org.OrgToken, customerUID);
    await this.syncGroupMembership(ctx, customerUID, postInt(form, "GroupUID"));

    await this.audit.log(ctx, {
      action: "UPDATE_CUSTOMER",
      entityType: "Customer",
      entityUID: customerUID,
      entityRef: String(row.Name ?? ""),
      summary: `Updated customer ${row.Name ?? ""}`,
      module: "Customers",
      category: "MASTER",
      oldValues: before,
      newValues: row,
    });

    const trimmed = (key: string) => String(postValue(form, key, "") ?? "").trim();
    return {
      Message: "Updated Successfully",
      Customer: {
        CustomerUID: customerUID,
        Name: trimmed("Name"),
        Area: trimmed("Area"),
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
      },
    };
  }

  // deleteCustomerData — soft delete; refused while the customer has transactions.
  async delete(dto: CustomerIdDto, ctx: WriteContext) {
    const customerUID = postInt(dto, "CustomerUID");
    if (!customerUID) throw new CiValidationError("Customer Information is Missing to Delete");
    const customer = await this.requireDeletable(ctx.orgUID, customerUID, "Customer not found", "Customer already deleted");
    if (await this.customers.hasTransactions(ctx.orgUID, customerUID)) {
      throw new CiValidationError("Customer has existing transactions (Invoices/Payments/Orders)");
    }

    await this.db.transaction(async (trx) => {
      await this.customers.softDelete(trx, ctx.orgUID, [customerUID], ctx.userUID);
      if (customer.LedgerUID) await this.ledger.deactivateForEntity(trx, ctx, "Customer", customerUID, Number(customer.LedgerUID));
    });

    const org = await this.orgSettings.get(ctx.orgUID);
    await this.cache.remove(org.OrgToken, customerUID);
    await this.audit.log(ctx, {
      action: "DELETE_CUSTOMER",
      entityType: "Customer",
      entityUID: customerUID,
      entityRef: customer.EntityName ?? "",
      summary: `Deleted customer ${customer.EntityName ?? customerUID}`,
      module: "Customers",
      category: "MASTER",
      oldValues: customer,
    });
    return { Message: "Deleted Successfully" };
  }

  // deleteBulkCustomers — the selected customers, or every customer matching the list filter (SelectAll = 1).
  async deleteBulk(dto: CustomerBulkDeleteDto, ctx: WriteContext) {
    let customerUIDs: number[];
    if (postInt(dto, "SelectAll")) {
      customerUIDs = await this.customers.findUIDsByFilter(ctx.orgUID, toListFilter(dto.Filter));
      if (customerUIDs.length === 0) throw new CiValidationError("No customers found matching the current filter.");
    } else {
      if (postValue(dto, "CustomerUIDs") === null) throw new CiValidationError("Customer Information is Missing to Delete");
      customerUIDs = postIntList(dto, "CustomerUIDs");
      if (customerUIDs.length === 0) throw new CiValidationError("Invalid customer IDs provided");
    }

    await this.db.transaction(async (trx) => {
      for (const customerUID of customerUIDs) {
        if (await this.customers.hasTransactions(ctx.orgUID, customerUID)) {
          throw new CiValidationError(`Customer ID ${customerUID} has existing transactions (Invoices/Payments/Orders)`);
        }
        const customer = await this.requireDeletable(
          ctx.orgUID,
          customerUID,
          `Customer ID ${customerUID} not found`,
          `Customer ID ${customerUID} is already deleted`
        );
        if (customer.LedgerUID) await this.ledger.deactivateForEntity(trx, ctx, "Customer", customerUID, Number(customer.LedgerUID));
      }
      await this.customers.softDelete(trx, ctx.orgUID, customerUIDs, ctx.userUID);
    });

    const org = await this.orgSettings.get(ctx.orgUID);
    for (const customerUID of customerUIDs) await this.cache.remove(org.OrgToken, customerUID);
    await this.audit.log(ctx, {
      action: "BULK_DELETE_CUSTOMERS",
      entityType: "Customer",
      entityUID: 0,
      entityRef: customerUIDs.join(","),
      details: { count: customerUIDs.length },
      summary: `Bulk deleted ${customerUIDs.length} customer(s)`,
      module: "Customers",
      category: "MASTER",
      oldValues: { deletedUIDs: customerUIDs },
    });
    return { Message: `${customerUIDs.length} customer(s) deleted successfully` };
  }

  // toggleCustomerStatus — an inactive customer is also removed from the transaction-form cache.
  async setStatus(dto: CustomerStatusDto, ctx: WriteContext) {
    const customerUID = postInt(dto, "CustomerUID");
    const isActive = postInt(dto, "IsActive");
    if (!customerUID) throw new CiValidationError("Customer ID is missing");
    if (isActive !== 0 && isActive !== 1) throw new CiValidationError("Invalid status value");

    const updated = await this.customers.setActive(ctx.orgUID, customerUID, isActive, ctx.userUID);
    if (updated === 0) throw new CiValidationError("Customer not found.");

    const org = await this.orgSettings.get(ctx.orgUID);
    if (isActive === 1) await this.cache.refresh(ctx.orgUID, org.OrgToken, customerUID);
    else await this.cache.remove(org.OrgToken, customerUID);

    await this.audit.log(ctx, {
      action: "TOGGLE_CUSTOMER_STATUS",
      entityType: "Customer",
      entityUID: customerUID,
      details: { isActive },
      summary: `${isActive ? "Activated" : "Deactivated"} customer #${customerUID}`,
      module: "Customers",
      category: "MASTER",
      oldValues: { IsActive: 1 - isActive },
      newValues: { IsActive: isActive },
    });
    return { Message: "Status updated successfully" };
  }

  // saveCustomerNote
  async addNote(dto: CustomerNoteDto, ctx: WriteContext) {
    const customerUID = postInt(dto, "CustomerUID");
    const note = (postString(dto, "Note") ?? "").trim();
    if (customerUID <= 0) throw new CiValidationError("Invalid customer.");
    if (!note) throw new CiValidationError("Note cannot be empty.");
    if (!(await this.customers.findDebitCreditRaw(ctx.orgUID, customerUID))) throw new CiValidationError("Customer not found.");
    await this.customers.insertNote(ctx.orgUID, customerUID, note, ctx.userUID);
    return { Message: "Note saved." };
  }

  // updateBillingAddress — inline billing-address edit (Tamil input stored in English, Tamil row in the background).
  async updateBillingAddress(dto: BillingAddressDto, ctx: WriteContext) {
    const customerUID = postInt(dto, "CustomerUID");
    const text = (key: string) => String(postValue(dto, key, "") ?? "").trim();
    if (customerUID <= 0 || text("Line1") === "") throw new CiValidationError("Line 1 is required.");
    if (!(await this.customers.findDebitCreditRaw(ctx.orgUID, customerUID))) throw new CiValidationError("Customer not found.");

    const address = { line1: text("Line1"), line2: text("Line2"), cityText: text("CityText"), stateText: text("StateText") };
    const typed = await this.translations.normalizeAddress(address);
    await this.customers.saveBillingAddress(
      await this.customers.findBillingAddressUID(ctx.orgUID, customerUID),
      {
        CustomerUID: customerUID,
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

    this.translations.scheduleAddressRows(customerUID, { Billing: typed }, ctx.userUID);
    const org = await this.orgSettings.get(ctx.orgUID);
    await this.cache.refresh(ctx.orgUID, org.OrgToken, customerUID);
    return { Message: "Address updated successfully." };
  }

  // Moving to another group resets the primary flag; staying keeps it; GroupUID 0 removes the membership.
  private async syncGroupMembership(ctx: WriteContext, customerUID: number, groupUID: number): Promise<void> {
    const existing = await this.customers.findGroupMembership(ctx.orgUID, customerUID);
    if (groupUID > 0) {
      const sameGroup = existing && Number(existing.GroupUID) === groupUID;
      await this.customers.saveGroupMembership(ctx.orgUID, customerUID, groupUID, sameGroup ? Number(existing.IsGroupPrimary) : 0, ctx.userUID);
    } else if (existing) {
      await this.customers.removeFromGroup(ctx.orgUID, customerUID, ctx.userUID);
    }
  }

  private async requireDeletable(orgUID: number, customerUID: number, notFound: string, alreadyDeleted: string) {
    const customer = await this.customers.findWithLedger(orgUID, customerUID);
    if (!customer) throw new CiValidationError(notFound);
    if (Number(customer.IsDeleted) === 1) throw new CiValidationError(alreadyDeleted);
    return customer;
  }

  private validate(form: CustomerFormDto): void {
    const errors = customerFormValidator.validate(form as unknown as Record<string, unknown>);
    if (Object.keys(errors).length > 0) throw new CiFieldValidationError(errors);
  }

  // The new/updated customer as a Select2 option: { id, text: "Name (Area)", address? } from the posted form
  private dropdownEntry(form: CustomerFormDto, customerUID: number) {
    const name = postString(form, "Name") ?? "";
    const area = postString(form, "Area");
    const entry: Record<string, unknown> = { id: customerUID, text: area ? `${name} (${area})` : name };
    if (postString(form, "BillAddrLine1")) {
      entry.address = {
        Line1: postString(form, "BillAddrLine1"),
        Line2: postString(form, "BillAddrLine2"),
        Pincode: postString(form, "BillAddrPincode"),
        City: postString(form, "BillAddrCityText"),
        State: postString(form, "BillAddrStateText"),
      };
    }
    return entry;
  }

  // returnList = 1: page 1 of the list and the stats, so the page refreshes without another call (never fails the save)
  private async listIfRequested(form: CustomerFormDto, orgUID: number) {
    if (String(form.returnList ?? "") !== "1") return {};
    try {
      const [page, stats] = await Promise.all([
        this.customersRead.getPage(orgUID, 1, { langCode: "en" }),
        this.customersRead.getStats(orgUID),
      ]);
      return { List: page.Data, TotalCount: page.TotalCount, Stats: stats.Data };
    } catch {
      return {};
    }
  }
}
