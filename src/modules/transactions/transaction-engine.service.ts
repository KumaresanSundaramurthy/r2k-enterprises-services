import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Knex } from "knex";
import { phpBool, todayDate } from "../../common/utils/php-compat";
import { DatabaseService } from "../../core/database/database.service";
import { OrgSettingsService } from "../../core/org/org-settings.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { buildDateRange } from "../../core/utils/date-range";
import { postInt, postJsonArray, postString, postValue } from "../../core/utils/form-values";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { CustomerCacheService } from "../customers/customer-cache.service";
import { CustomersRepository } from "../customers/customers.repository";
import { AdditionalChargesRepository } from "../settings/additional-charges.service";
import { SettingsLookupsRepository } from "../settings/settings-lookups.repository";
import { VendorCacheService } from "../vendors/vendor-cache.service";
import { VendorsRepository } from "../vendors/vendors.repository";
import { DocumentEffectsService } from "./document-effects.service";
import { DocumentPaymentsRepository } from "./document-payments.repository";
import { TransactionAttachmentsService, UploadedFile } from "./transaction-attachments.service";
import { Form, ItemInput, readTransactionForm, TransAmounts } from "./transaction-form";
import { DocumentKind, PURCHASE_RETURN, SALES_RETURN } from "./transaction-kinds";
import { TransactionLookupsRepository } from "./transaction-lookups.repository";
import { buildUniqueNumber, MAX_TRANS_NUMBER, PrefixRow } from "./transaction-number";
import { ChargeInput, TransactionWritesRepository } from "./transaction-writes.repository";
import { TransactionsRepository, TransFilter } from "./transactions.repository";

type Row = Record<string, unknown>;

const TOO_LARGE = "Transaction number exceeds the maximum allowed value of 2,147,483,647. Please use a smaller number or create a new prefix series.";
const SERIES_FULL = "This prefix series has reached its maximum (2,147,483,647). Please create a new prefix to continue.";
const INSERT_RETRIES = 5;

const text = (value: unknown, max: number) => String(value ?? "").replace(/<[^>]*>/g, "").slice(0, max);
const optionalText = (value: unknown, max: number) => (value ? String(value).slice(0, max) : null);
const optionalInt = (value: unknown) => (value ? parseInt(String(value), 10) || null : null);
const num = (value: unknown) => Number(value ?? 0) || 0;
const productOf = (item: ItemInput) => parseInt(String(item.productUID ?? item.id ?? 0), 10) || 0;

// Y-m-d plus a number of days (PHP date('Y-m-d', strtotime("$date +N days")))
export function addDays(ymd: string, days: number): string {
  const date = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface ResolvedNumber {
  prefix: PrefixRow | null;
  prefixUID: number | null;
  transNumber: number | null;
  uniqueNumber: string | null;
}

/** Per-save values the document type fills in (customer / vendor, validity / delivery / due date). */
export interface SaveInput {
  partyUID: number;
  validityDate: string | null;
  validityDays: number | null;
  // Further TransDetailTbl columns the document type stores (pending credit note, challan dates, …)
  extraDetail?: Row;
}

export interface SavedDocument {
  transUID: number;
  uniqueNumber: string | null;
  token: string;
  isDraft: boolean;
  amounts: TransAmounts;
}

// A document just written by create(), as the document type's own work inside the transaction sees it
export interface CreatedDocument {
  transUID: number;
  isDraft: boolean;
  uniqueNumber: string | null;
  amounts: TransAmounts;
}

// A document just written by update(): activeUID differs from transUID when a finalised draft was re-inserted
export interface UpdatedDocument extends CreatedDocument {
  existing: Row;
  activeUID: number;
  cloned: boolean;
}

export interface UpdateHooks {
  // Extra header columns, written both on the in-place update and on a re-inserted row
  header?: (existing: Row, amounts: TransAmounts) => Row;
  // The document type's own work after the lines are saved, inside the transaction
  inside?: (trx: Knex.Transaction, doc: UpdatedDocument) => Promise<void>;
}

export interface StatusChange {
  // Extra header columns set with the new status
  fields?: Row;
  // The document type's own work after the status is set, inside the transaction
  inside?: (trx: Knex.Transaction, existing: Row) => Promise<void>;
}

export type DispatchData = "list" | "single" | "none";

/**
 * The transaction engine the sales and purchase documents share (CI3 MY_Controller transaction helpers):
 * numbering, header / detail / lines / charges, drafts, list, status and the page and form data.
 */
@Injectable()
export class TransactionEngineService {
  private readonly logger = new Logger(TransactionEngineService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly reads: TransactionsRepository,
    private readonly writes: TransactionWritesRepository,
    private readonly lookups: TransactionLookupsRepository,
    private readonly attachments: TransactionAttachmentsService,
    private readonly orgSettings: OrgSettingsService,
    private readonly orgInfo: OrgInfoCacheService,
    private readonly customers: CustomersRepository,
    private readonly customerCache: CustomerCacheService,
    private readonly charges: AdditionalChargesRepository,
    private readonly settingsLookups: SettingsLookupsRepository,
    private readonly vendors: VendorsRepository,
    private readonly vendorCache: VendorCacheService,
    private readonly effects: DocumentEffectsService,
    private readonly payments: DocumentPaymentsRepository
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────

  /** The organisation's document of this type, or the type's "not found" message. */
  async document(kind: DocumentKind, orgUID: number, transUID: number, langCode = "en"): Promise<Row> {
    const row = await this.reads.find(orgUID, transUID, kind.moduleUID, langCode);
    if (!row) throw new CiValidationError(`${kind.label} not found.`);
    return row;
  }

  items(orgUID: number, transUID: number) {
    return this.reads.items(orgUID, transUID);
  }

  attachmentsOf(orgUID: number, transUID: number) {
    return this.reads.attachments(orgUID, transUID);
  }

  chargesOf(orgUID: number, transUID: number) {
    return this.reads.charges(orgUID, transUID);
  }

  // getPageDetails — the CI3 JS builds the rows from Data
  async listPage(kind: DocumentKind, orgUID: number, branchUID: number, pageNo: number, rowLimit: number | undefined, filter: TransFilter, langCode: string) {
    const limit = await this.orgSettings.resolveRowLimit(orgUID, rowLimit);
    const scoped = { ...filter, BranchUID: branchUID };
    const [rows, total, settings, templates] = await Promise.all([
      this.reads.list(orgUID, kind.moduleUID, scoped, limit, (pageNo - 1) * limit, langCode),
      this.reads.count(orgUID, kind.moduleUID, scoped),
      this.lookups.settings(orgUID),
      kind.listWhatsApp ? this.lookups.messageTemplates(orgUID, kind.moduleUID) : Promise.resolve(null),
    ]);
    return {
      Data: await this.annotate(kind, orgUID, rows),
      TotalCount: total,
      PageNo: pageNo,
      RowLimit: limit,
      ...(templates ? { WhatsAppTemplate: templates.WhatsApp ?? null } : {}),
      ...(kind.listStats && settings.showStats ? { SummaryStats: await this.reads.summaryStats(orgUID, kind.moduleUID, scoped) } : {}),
    };
  }

  /**
   * _annotatePRListWithCancelDeps / _annotateSRListWithCancelDeps — the cash refunds each return received
   * (CancelCashRefunded) and, for sales returns, the credit already applied to invoices (CancelCreditApplied).
   */
  private async annotate(kind: DocumentKind, orgUID: number, rows: Row[]): Promise<Row[]> {
    if (kind.moduleUID !== PURCHASE_RETURN.moduleUID && kind.moduleUID !== SALES_RETURN.moduleUID) return rows;
    const refunded = await this.payments.refundedTotals(orgUID, rows.map((row) => Number(row.TransUID)));
    if (kind.moduleUID === PURCHASE_RETURN.moduleUID) return rows.map((row) => ({ ...row, CancelCashRefunded: refunded.get(Number(row.TransUID)) ?? 0 }));
    const credited = await this.payments.creditAppliedByNumbers(orgUID, rows.map((row) => String(row.UniqueNumber ?? "")).filter(Boolean));
    return rows.map((row) => ({ ...row, CancelCashRefunded: refunded.get(Number(row.TransUID)) ?? 0, CancelCreditApplied: credited.get(String(row.UniqueNumber ?? "")) ?? 0 }));
  }

  // _buildListResponse — the page the list was on, for the posted Filter / RowLimit / PageNo
  async listAfterChange(kind: DocumentKind, ctx: WriteContext, form: Form, langCode = "en") {
    const page = await this.listPage(kind, ctx.orgUID, ctx.branchUID ?? 1, Math.max(1, postInt(form, "PageNo")), postInt(form, "RowLimit") || undefined, TransactionEngineService.postedFilter(form.Filter), langCode);
    return { Data: page.Data, TotalCount: page.TotalCount, PageNo: page.PageNo, RowLimit: page.RowLimit };
  }

  /**
   * _buildPaymentListResponse — after a payment: the list page posted as CurrentPage (the organisation's row
   * limit) with the summary stats, which the payment changed.
   */
  async listAfterPayment(kind: DocumentKind, ctx: WriteContext, form: Form, langCode = "en") {
    const filter = TransactionEngineService.postedFilter(form.Filter);
    const branchUID = ctx.branchUID ?? 1;
    const page = await this.listPage(kind, ctx.orgUID, branchUID, Math.max(1, postInt(form, "CurrentPage")), undefined, filter, langCode);
    return {
      Data: page.Data,
      TotalCount: page.TotalCount,
      PageNo: page.PageNo,
      RowLimit: page.RowLimit,
      SummaryStats: await this.reads.summaryStats(ctx.orgUID, kind.moduleUID, { ...filter, BranchUID: branchUID }),
    };
  }

  // _loadTransactionIndexPage — saved date range, initial tab / search, stats, filter users and message templates
  async pageData(kind: DocumentKind, orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    const [settings, txSettings, saved, users, templates] = await Promise.all([
      this.orgSettings.get(orgUID),
      this.lookups.settings(orgUID),
      this.lookups.preference(orgUID, branchUID, userUID, kind.datePreference),
      this.lookups.orgUsers(orgUID),
      this.lookups.messageTemplates(orgUID, kind.moduleUID),
    ]);
    const range = buildDateRange(saved || "this_month", settings.Timezone);
    const statsFilter: TransFilter = range.from ? { DateFrom: range.from, DateTo: range.to } : {};
    const initTab = kind.tabSlugMap[(tab || "all").trim().toLowerCase()] ?? "All";
    const initFilter: TransFilter = { ...statsFilter, ...(initTab !== "All" ? { Status: initTab } : {}), ...(search.trim() ? { Name: search.trim() } : {}) };
    const email = templates.Email;
    let orgContext: Row | null = null;
    try {
      orgContext = await this.orgInfo.get(orgUID);
    } catch (err) {
      this.logger.warn(`Org info for page data unavailable: ${(err as Error).message}`);
    }
    return {
      RowLimit: settings.RowLimit,
      SavedDateRange: range.range,
      SavedDateLabel: range.label,
      SavedDateFrom: range.from,
      SavedDateTo: range.to,
      InitTab: initTab,
      InitSearch: search.trim(),
      InitFilter: initFilter,
      SummaryStats: txSettings.showStats ? await this.reads.summaryStats(orgUID, kind.moduleUID, { ...statsFilter, BranchUID: branchUID }) : {},
      OrgUsers: users,
      CommOrgContext: orgContext,
      CommEmailTemplate: email ? { Subject: email.Subject ?? "", Body: email.Body ?? "" } : null,
      WhatsAppTemplate: templates.WhatsApp ?? null,
    };
  }

  // create / edit form: prefixes with their next numbers, dispatch address(es), storage, charges and taxes
  async formBasics(kind: DocumentKind, orgUID: number, langCode: string, dispatchData: DispatchData = "list") {
    const [prefixes, settings, allCharges, taxes] = await Promise.all([
      this.reads.prefixes(orgUID, kind.moduleUID),
      this.lookups.settings(orgUID),
      this.charges.list(orgUID),
      this.settingsLookups.taxDetails(),
    ]);
    const nextNumbers: Record<number, number> = {};
    for (const prefix of prefixes) nextNumbers[Number(prefix.PrefixUID)] = await this.reads.nextNumber(orgUID, kind.moduleUID, Number(prefix.PrefixUID));
    let dispatch: Row = {};
    if (dispatchData === "list") {
      const addresses = await this.lookups.dispatchAddresses(orgUID);
      dispatch = { DispatchAddresses: addresses, DispatchAddress: addresses[0] ?? null };
    } else if (dispatchData === "single") {
      dispatch = { DispatchAddress: await this.lookups.dispatchAddress(orgUID) };
    }
    return {
      PrefixData: prefixes,
      NextNumberMap: nextNumbers,
      ...dispatch,
      fltStorageData: settings.enableStorage ? await this.lookups.storages(orgUID, langCode) : [],
      AdditionalCharges: allCharges.filter((charge) => Number(charge.ShowByDefault) === 1),
      AcNextSortOrder: allCharges.reduce((max, charge) => Math.max(max, Number(charge.SortOrder) || 0), 0) + 1,
      TaxList: taxes,
      QuotValidityDays: settings.quotValidityDays,
    };
  }

  // The customer's shipping address, else billing, else the first one (edit form)
  async customerAddress(customerUID: number, langCode: string): Promise<Row | null> {
    const addresses = await this.customers.findAddresses(customerUID, langCode);
    return addresses.find((a) => a.AddressType === "Shipping") ?? addresses.find((a) => a.AddressType === "Billing") ?? addresses[0] ?? null;
  }

  // getVendorAddress — the vendor's first address (edit form, inter-state detection)
  async vendorAddress(vendorUID: number, langCode: string): Promise<Row | null> {
    if (vendorUID <= 0) return null;
    return (await this.vendors.findAddresses(vendorUID, langCode))[0] ?? null;
  }

  // ── Writes ───────────────────────────────────────────────────────────

  /**
   * add — header (numbered unless a draft; a number taken meanwhile is retried with the next one), charges,
   * detail and lines in one transaction; `inside` runs last in it (conversion tracking, stock, serials,
   * payments). Files and the party's cache follow the commit.
   */
  async create(kind: DocumentKind, ctx: WriteContext, form: Form, input: SaveInput, files: UploadedFile[], inside?: (trx: Knex.Transaction, doc: CreatedDocument) => Promise<void>): Promise<SavedDocument> {
    const amounts = readTransactionForm(form);
    await this.checkParty(kind, ctx.orgUID, input.partyUID);
    const saved = await this.db.write.transaction(async (trx) => {
      const resolved = await this.resolveNumber(trx, kind, ctx.orgUID, amounts);
      const header = this.header(kind, ctx, amounts, form, input.partyUID, resolved);
      const transUID = await this.insertWithRetry(trx, kind, ctx.orgUID, header, resolved, amounts.transDate);
      await this.writes.saveCharges(trx, ctx.orgUID, transUID, ctx.userUID, TransactionEngineService.postedCharges(form));
      await this.writes.insertDetail(trx, { FinancialYear: amounts.financialYear, TransUID: transUID, ...(await this.detail(trx, kind, ctx.orgUID, form, input)) });
      await this.writes.insertItems(trx, TransactionEngineService.itemRows(amounts.items, transUID, amounts.financialYear, ctx));
      const uniqueNumber = header.UniqueNumber as string | null;
      if (inside) await inside(trx, { transUID, isDraft: amounts.isDraft, uniqueNumber, amounts });
      return { transUID, uniqueNumber, token: String(header.TransToken), isDraft: amounts.isDraft, amounts };
    });
    await this.attachments.save(ctx, kind, saved.transUID, files);
    await this.touchParty(kind, ctx.orgUID, input.partyUID);
    return saved;
  }

  /**
   * update — a draft being finalised gets its number here. When other documents were created after the draft,
   * it is re-inserted as a new row (so it sorts with them) and the draft row removed; otherwise updated in place.
   */
  async update(
    kind: DocumentKind,
    ctx: WriteContext,
    form: Form,
    input: SaveInput,
    files: UploadedFile[],
    hooks: UpdateHooks = {}
  ): Promise<SavedDocument & { previousNumber: string | null; existing: Row }> {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError(`${kind.label} ID is required.`);
    const amounts = readTransactionForm(form);
    const { orgUID, userUID } = ctx;
    await this.checkParty(kind, orgUID, input.partyUID);

    const saved = await this.db.write.transaction(async (trx) => {
      const existing = await this.reads.find(orgUID, transUID, kind.moduleUID, "en", trx);
      if (!existing) throw new CiValidationError(`${kind.label} not found.`);
      const finalising = existing.DocStatus === "Draft" && !amounts.isDraft;
      const resolved = finalising ? await this.finaliseNumber(trx, kind, orgUID, amounts) : null;
      const detail = await this.detail(trx, kind, orgUID, form, input);
      const extraHeader = hooks.header ? hooks.header(existing, amounts) : {};

      let activeUID = transUID;
      const cloned = finalising && !kind.noReinsert && (await this.reads.hasNewer(trx, orgUID, kind.moduleUID, transUID));
      if (cloned) {
        const header = { ...this.header(kind, ctx, amounts, form, input.partyUID, resolved!), ...extraHeader };
        activeUID = await this.writes.insertHeader(trx, header);
        await this.writes.updateDetail(trx, transUID, amounts.financialYear, { ...detail, TransUID: activeUID });
        await this.writes.softDeleteItems(trx, orgUID, transUID, userUID);
        await this.writes.insertItems(trx, TransactionEngineService.itemRows(amounts.items, activeUID, amounts.financialYear, ctx));
        await this.writes.moveChildren(trx, orgUID, transUID, activeUID);
        await this.writes.deleteHeader(trx, orgUID, transUID);
      } else {
        await this.writes.updateHeader(trx, orgUID, transUID, {
          ...this.updateHeader(kind, ctx, amounts, form, input.partyUID),
          ...extraHeader,
          ...(resolved ? { PrefixUID: resolved.prefixUID, TransNumber: resolved.transNumber, UniqueNumber: resolved.uniqueNumber } : {}),
        });
        await this.writes.updateDetail(trx, transUID, amounts.financialYear, detail);
        await this.updateItems(trx, ctx, transUID, amounts);
      }
      const uniqueNumber = resolved?.uniqueNumber ?? null;
      if (hooks.inside) await hooks.inside(trx, { existing, transUID, activeUID, cloned, isDraft: amounts.isDraft, uniqueNumber, amounts });
      await this.writes.saveCharges(trx, orgUID, activeUID, userUID, TransactionEngineService.postedCharges(form));
      return { transUID: activeUID, uniqueNumber, previousNumber: (existing.UniqueNumber as string | null) ?? null, isDraft: amounts.isDraft, amounts, existing };
    });

    await this.attachments.save(ctx, kind, saved.transUID, files);
    await this.attachments.remove(ctx, saved.transUID, postValue(form, "RemovedAttachIDs"));
    await this.touchParty(kind, orgUID, input.partyUID);
    const token = await this.writes.token(this.db.write, orgUID, saved.transUID, randomUUID());
    return { ...saved, token };
  }

  // delete… — the document and its lines are soft-deleted; `inside` runs first in the same transaction
  async delete(kind: DocumentKind, ctx: WriteContext, transUID: number, inside?: (trx: Knex.Transaction, existing: Row) => Promise<void>): Promise<Row> {
    if (transUID <= 0) throw new CiValidationError(`${kind.label} ID is required.`);
    const existing = await this.document(kind, ctx.orgUID, transUID);
    await this.db.write.transaction(async (trx) => {
      if (inside) await inside(trx, existing);
      await this.writes.softDeleteItems(trx, ctx.orgUID, transUID, ctx.userUID);
      await this.writes.softDeleteHeader(trx, ctx.orgUID, transUID, ctx.userUID);
    });
    return existing;
  }

  /**
   * deleteMultipleTransactions — the posted TransUIDs or, with SelectAll = 1, every document matching the Filter;
   * each one on its own, the rest carry on when one fails. A stock-moving document's stock is reversed with it,
   * and its vendor accounts follow the commit (Transactions::_deleteSingleTransaction).
   */
  async deleteMany(kind: DocumentKind, ctx: WriteContext, form: Form) {
    let uids: number[];
    if (postInt(form, "SelectAll") === 1) {
      uids = await this.reads.uidsByFilter(ctx.orgUID, kind.moduleUID, { ...TransactionEngineService.postedFilter(form.Filter), BranchUID: ctx.branchUID ?? 1 });
    } else {
      const posted = postJsonArray<unknown>(form, "TransUIDs");
      const raw = posted.length > 0 ? posted : String(postValue(form, "TransUIDs") ?? "").split(",");
      uids = raw.map((uid) => parseInt(String(uid), 10)).filter((uid) => uid > 0);
    }
    if (uids.length === 0) throw new CiValidationError("No records selected.");

    let deleted = 0;
    const errors: string[] = [];
    for (const transUID of uids) {
      try {
        const existing = await this.reads.find(ctx.orgUID, transUID, kind.moduleUID);
        if (!existing) throw new Error(`Transaction #${transUID} not found.`);
        await this.effects.checkBulkDelete(kind, ctx, existing);
        const reversed = await this.db.write.transaction(async (trx) => {
          const products = await this.effects.insideBulkDelete(trx, kind, ctx, existing);
          await this.writes.softDeleteItems(trx, ctx.orgUID, transUID, ctx.userUID);
          await this.writes.softDeleteHeader(trx, ctx.orgUID, transUID, ctx.userUID);
          return products;
        });
        deleted++;
        await this.effects.afterBulkDelete(kind, ctx, existing, reversed);
      } catch (err) {
        errors.push(`#${transUID}: ${(err as Error).message}`);
      }
    }
    if (deleted === 0) throw new CiValidationError(errors.join("; ") || "No records deleted.");
    return { deleted, errors };
  }

  /**
   * duplicate… — a Draft copy dated today with the next number on the source's prefix (numbered the classic way,
   * as CI3 does), the same party, amounts, notes and lines. Returns the copy's UID and number.
   */
  async duplicate(kind: DocumentKind, ctx: WriteContext, sourceUID: number, invalidMessage: string): Promise<{ transUID: number; uniqueNumber: string; token: string }> {
    if (sourceUID <= 0) throw new CiValidationError(invalidMessage);
    const { orgUID, userUID } = ctx;
    const source = await this.document(kind, orgUID, sourceUID);
    const prefixUID = Number(source.PrefixUID) || 0;
    const [prefix] = prefixUID > 0 ? await this.reads.prefixes(orgUID, undefined, prefixUID) : [];
    if (!prefix) throw new CiValidationError("Prefix not found.");
    const today = todayDate();
    const year = Number(today.slice(0, 4));
    const nextNumber = await this.reads.nextNumber(orgUID, kind.moduleUID, prefixUID);
    const uniqueNumber = buildUniqueNumber({ ...prefix, ComponentConfig: null }, nextNumber, today);
    const token = randomUUID();

    const transUID = await this.db.write.transaction(async (trx) => {
      const newUID = await this.writes.insertHeader(trx, {
        OrgUID: orgUID,
        // CI3 left out the branch and the (required) token, so the copy failed to save
        BranchUID: ctx.branchUID ?? 1,
        TransToken: token,
        ModuleUID: kind.moduleUID,
        PrefixUID: prefixUID,
        UniqueNumber: uniqueNumber,
        TransType: kind.transType,
        TransNumber: nextNumber,
        PartyType: source.PartyType,
        PartyUID: source.PartyUID,
        TransDate: today,
        TransYear: year,
        DocType: source.DocType,
        DispatchFrom: source.DispatchFrom ?? null,
        TotalQuantity: num(source.TotalQuantity),
        TotalItems: num(source.TotalItems),
        GrossAmount: source.GrossAmount,
        SubTotal: source.SubTotal,
        DiscountAmount: source.DiscountAmount,
        AdditionalCharges: source.AdditionalCharges,
        TaxAmount: source.TaxAmount,
        CgstAmount: source.CgstAmount,
        SgstAmount: source.SgstAmount,
        IgstAmount: source.IgstAmount,
        RoundOff: source.RoundOff,
        GlobalDiscPercent: num(source.GlobalDiscPercent),
        ExtraDiscApplied: phpBool(source.ExtraDiscApplied) ? 1 : 0,
        ExtraDiscAmount: source.ExtraDiscAmount,
        ExtraDiscType: source.ExtraDiscType,
        NetAmount: source.NetAmount,
        DocStatus: "Draft",
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
      // Only a customer has a country to compare; a vendor document's flag stays NULL as in CI3
      const country = kind.partyType === "C" ? await this.reads.customerCountry(orgUID, num(source.PartyUID), trx) : null;
      await this.writes.insertDetail(trx, {
        FinancialYear: year,
        TransUID: newUID,
        ValidityDays: null,
        ValidityDate: null,
        Reference: source.Reference ?? null,
        Notes: source.Notes ?? null,
        TermsConditions: source.TermsConditions ?? null,
        SignatureUID: source.SignatureUID ?? null,
        IsInterState: num(source.IgstAmount) > 0 ? 1 : num(source.CgstAmount) > 0 || num(source.SgstAmount) > 0 ? 0 : null,
        IsForeignCustomer: country === null ? null : country === "IN" ? 0 : 1,
      });
      const lines = await this.reads.items(orgUID, sourceUID, trx);
      await this.writes.insertItems(
        trx,
        lines.map((line, index) => ({
          OrgUID: orgUID,
          FinancialYear: year,
          TransUID: newUID,
          ItemSequence: index + 1,
          ProductUID: line.ProductUID,
          ProductName: line.ProductName,
          PartNumber: line.PartNumber,
          CategoryUID: line.CategoryUID,
          StorageUID: line.StorageUID,
          Quantity: line.Quantity,
          PrimaryUnitName: line.PrimaryUnitName,
          TaxDetailsUID: line.TaxDetailsUID,
          TaxPercentage: line.TaxPercentage,
          CGST: line.CGST,
          SGST: line.SGST,
          IGST: line.IGST,
          DiscountTypeUID: line.DiscountTypeUID,
          Discount: line.Discount,
          UnitPrice: line.UnitPrice,
          SellingPrice: line.SellingPrice,
          TaxableAmount: line.TaxableAmount,
          CgstAmount: line.CgstAmount,
          SgstAmount: line.SgstAmount,
          IgstAmount: line.IgstAmount,
          TaxAmount: line.TaxAmount,
          DiscountAmount: line.DiscountAmount,
          NetAmount: line.NetAmount,
          QuantityConverted: 0,
          IsCompliment: num(line.IsCompliment),
          IsActive: 1,
          IsDeleted: 0,
          CreatedBy: userUID,
          UpdatedBy: userUID,
        }))
      );
      return newUID;
    });
    return { transUID, uniqueNumber, token };
  }

  /**
   * update…Status — only the transitions the document type allows; returns the document as it was. The type may
   * set more header columns with the status and do its own work (stock reversal, …) in the same transaction.
   */
  async changeStatus(
    kind: DocumentKind,
    ctx: WriteContext,
    transUID: number,
    newStatus: string,
    transitions: Record<string, string[]>,
    invalidMessage: string,
    change: StatusChange = {}
  ): Promise<Row> {
    if (transUID <= 0) throw new CiValidationError(invalidMessage);
    const existing = await this.document(kind, ctx.orgUID, transUID);
    const current = String(existing.DocStatus ?? "");
    if (!(transitions[current] ?? []).includes(newStatus)) throw new CiValidationError(`Cannot change status from ${current} to ${newStatus}.`);
    await this.db.write.transaction(async (trx) => {
      if (change.fields) await this.writes.updateHeader(trx, ctx.orgUID, transUID, { DocStatus: newStatus, UpdatedBy: ctx.userUID, ...change.fields });
      else await this.writes.setStatus(trx, ctx.orgUID, transUID, newStatus, ctx.userUID);
      if (change.inside) await change.inside(trx, existing);
    });
    return existing;
  }

  // cancelTransactionChildRecords — inside the status change of a cancelled document (org-scoped; CI3 matched TransUID alone)
  cancelChildRecords(trx: Knex.Transaction, ctx: WriteContext, transUID: number) {
    return this.writes.cancelChildRecords(trx, ctx.orgUID, transUID, ctx.userUID);
  }

  // getTransactionByToken — the TransUID behind an edit link token (0 when unknown)
  async uidByToken(kind: DocumentKind, orgUID: number, token: string): Promise<number> {
    return token ? this.reads.uidByToken(orgUID, kind.moduleUID, token) : 0;
  }

  // The document's live lines are soft-deleted (a cancelled purchase return)
  softDeleteLines(trx: Knex.Transaction, ctx: WriteContext, transUID: number) {
    return this.writes.softDeleteItems(trx, ctx.orgUID, transUID, ctx.userUID);
  }

  async setStatus(trx: Knex.Transaction, orgUID: number, transUID: number, status: string, userUID: number) {
    await this.writes.setStatus(trx, orgUID, transUID, status, userUID);
  }

  recordConversion(trx: Knex.Transaction, row: Parameters<TransactionWritesRepository["recordConversion"]>[1]) {
    return this.writes.recordConversion(trx, row);
  }

  // ── Numbering ────────────────────────────────────────────────────────

  // _resolveTransPrefix — a draft has no number; otherwise the number must be free on an organisation prefix
  private async resolveNumber(trx: Knex.Transaction, kind: DocumentKind, orgUID: number, amounts: TransAmounts): Promise<ResolvedNumber> {
    if (amounts.isDraft) return { prefix: null, prefixUID: null, transNumber: null, uniqueNumber: null };
    const { prefixUID, transNumber, transDate } = amounts;
    if (transNumber <= 0) throw new CiValidationError("Transaction number must be greater than 0.");
    if (transNumber > MAX_TRANS_NUMBER) throw new CiValidationError(TOO_LARGE);
    const [prefix] = await this.reads.prefixes(orgUID, undefined, prefixUID || -1, trx);
    if (!prefix) throw new CiValidationError("Invalid prefix selected.");
    if (await this.reads.numberTaken(trx, orgUID, prefixUID, transNumber)) {
      const next = await this.reads.nextNumber(orgUID, kind.moduleUID, prefixUID, trx);
      throw new CiValidationError(`Transaction number ${transNumber} already exists for this prefix. Next available: ${next}.`);
    }
    return { prefix, prefixUID, transNumber, uniqueNumber: buildUniqueNumber(prefix, transNumber, transDate) };
  }

  // A draft being finalised: quotations move on to the next free number, sales orders refuse a taken one
  private async finaliseNumber(trx: Knex.Transaction, kind: DocumentKind, orgUID: number, amounts: TransAmounts): Promise<ResolvedNumber> {
    const { prefixUID, transDate } = amounts;
    let { transNumber } = amounts;
    if (prefixUID <= 0) throw new CiValidationError(kind.finaliseNoPrefix);
    if (transNumber <= 0) throw new CiValidationError("Transaction number must be greater than 0.");
    if (transNumber > MAX_TRANS_NUMBER) throw new CiValidationError(TOO_LARGE);
    const [prefix] = await this.reads.prefixes(orgUID, undefined, prefixUID, trx);
    if (!prefix) throw new CiValidationError("Invalid prefix selected.");
    if (await this.reads.numberTaken(trx, orgUID, prefixUID, transNumber)) {
      if (kind.onTakenNumber === "refuse") {
        const next = await this.reads.nextNumber(orgUID, kind.moduleUID, prefixUID, trx);
        throw new CiValidationError(`Transaction number ${transNumber} already exists. Next available: ${next}.`);
      }
      transNumber = await this.reads.nextAvailableNumber(trx, orgUID, prefixUID);
      if (transNumber === -1) throw new CiValidationError(SERIES_FULL);
    }
    return { prefix, prefixUID, transNumber, uniqueNumber: buildUniqueNumber(prefix, transNumber, transDate) };
  }

  // _insertTransactionWithRetry — a number taken by a concurrent save is replaced by the next one (5 retries)
  private async insertWithRetry(trx: Knex.Transaction, kind: DocumentKind, orgUID: number, header: Row, resolved: ResolvedNumber, transDate: string): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.writes.insertHeader(trx, header);
      } catch (err) {
        if (!/Duplicate entry/i.test((err as Error).message) || !resolved.prefix || resolved.prefixUID === null) throw err;
        if (attempt >= INSERT_RETRIES) throw new CiValidationError("Could not assign a transaction number. Please try again.");
        const next = await this.reads.nextNumber(orgUID, kind.moduleUID, resolved.prefixUID, trx);
        if (next === -1) throw new CiValidationError(SERIES_FULL);
        header.TransNumber = next;
        header.UniqueNumber = buildUniqueNumber(resolved.prefix, next, transDate);
      }
    }
  }

  // ── Row builders ─────────────────────────────────────────────────────

  // _buildTransHeader — a bill that takes payments starts unpaid (hasPaidAmount / hasIsFullyPaid)
  private header(kind: DocumentKind, ctx: WriteContext, amounts: TransAmounts, form: Form, partyUID: number, resolved: ResolvedNumber): Row {
    return {
      ...this.updateHeader(kind, ctx, amounts, form, partyUID),
      PrefixUID: resolved.prefixUID,
      UniqueNumber: resolved.uniqueNumber,
      TransNumber: resolved.transNumber,
      TransToken: randomUUID(),
      ...(kind.tracksPayments ? { PaidAmount: 0, BalanceAmount: amounts.netAmount, IsFullyPaid: 0 } : {}),
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: ctx.userUID,
    };
  }

  // _buildTransUpdateHeader — the amounts, party and status; the stored PDF is cleared so it is rebuilt
  private updateHeader(kind: DocumentKind, ctx: WriteContext, amounts: TransAmounts, form: Form, partyUID: number): Row {
    return {
      OrgUID: ctx.orgUID,
      BranchUID: ctx.branchUID ?? 1,
      ModuleUID: kind.moduleUID,
      TransType: kind.transType,
      PartyType: kind.partyType,
      PartyUID: partyUID,
      TransDate: amounts.transDate,
      TransYear: amounts.financialYear,
      DocType: postString(form, kind.docTypePostKey) || kind.docTypeDefault || null,
      DispatchFrom: kind.dispatchPostKey ? postString(form, kind.dispatchPostKey) || null : null,
      TotalQuantity: amounts.totalQty,
      TotalItems: amounts.totalItems,
      GrossAmount: amounts.subTotal + amounts.discountAmount,
      SubTotal: amounts.subTotal,
      TaxableAmount: amounts.subTotal,
      DiscountAmount: amounts.discountAmount,
      AdditionalCharges: amounts.additionalChargesTotal,
      TaxAmount: amounts.taxAmount,
      CgstAmount: amounts.cgstAmount,
      SgstAmount: amounts.sgstAmount,
      IgstAmount: amounts.igstAmount,
      RoundOff: amounts.roundOff,
      GlobalDiscPercent: amounts.globalDiscPercent,
      ExtraDiscApplied: amounts.extraDiscount > 0 ? 1 : 0,
      ExtraDiscAmount: amounts.extraDiscount,
      ExtraDiscType: postString(form, "extDiscountType") || null,
      NetAmount: amounts.netAmount,
      DocStatus: amounts.isDraft ? "Draft" : kind.initialStatus,
      UpdatedBy: ctx.userUID,
      PdfPath: null,
    };
  }

  /**
   * _buildTransDetail — validity / delivery / due date, notes, terms, signature, place of supply, price list, the
   * supplier's invoice number (purchase bills). IsForeignCustomer is worked out for customers only.
   */
  private async detail(trx: Knex.Transaction, kind: DocumentKind, orgUID: number, form: Form, input: SaveInput): Promise<Row> {
    const interState = postValue(form, "isInterState");
    const country = kind.partyType === "C" ? await this.reads.customerCountry(orgUID, input.partyUID, trx) : null;
    return {
      ...(kind.supplierInvoicePostKey ? { SupplierInvoiceNo: postString(form, kind.supplierInvoicePostKey) || null } : {}),
      ValidityDays: input.validityDays,
      ValidityDate: input.validityDate,
      Reference: postString(form, kind.referencePostKey ?? "referenceDetails") || null,
      Notes: postString(form, "transNotes") || null,
      TermsConditions: postString(form, "transTermsCond") || null,
      SignatureUID: postInt(form, "SignatureUID") || null,
      PlaceOfSupplyCode: postString(form, "placeOfSupplyCode") || null,
      PlaceOfSupplyName: postString(form, "placeOfSupplyName") || null,
      IsInterState: interState === null ? null : parseInt(String(interState), 10) || 0,
      IsForeignCustomer: country === null ? null : country === "IN" ? 0 : 1,
      PriceListUID: postInt(form, "PriceListUID") || null,
      PriceListData: postString(form, "PriceListData") || null,
      ...(input.extraDetail ?? {}),
    };
  }

  // The fields of a line both inserts and updates write (_insertTransItems / _updateTransItems)
  private static itemFields(item: ItemInput, sequence: number, userUID: number): Row {
    const unitPrice = num(item.unitPrice);
    return {
      ItemSequence: sequence,
      ProductName: text(item.itemName, 100),
      Description: optionalText(item.description, 500),
      PartNumber: optionalText(item.partNumber, 50),
      CategoryUID: optionalInt(item.categoryUID),
      CategoryName: optionalText(item.categoryName, 100),
      StorageUID: item.storageUID === undefined || item.storageUID === null ? null : parseInt(String(item.storageUID), 10) || 0,
      Quantity: num(item.quantity),
      PrimaryUnitName: item.primaryUnit === undefined || item.primaryUnit === null ? null : String(item.primaryUnit).slice(0, 20),
      TaxDetailsUID: item.taxDetailsUID === undefined || item.taxDetailsUID === null ? 1 : parseInt(String(item.taxDetailsUID), 10) || 0,
      TaxPercentage: num(item.taxPercent),
      CGST: num(item.cgstPercent),
      SGST: num(item.sgstPercent),
      IGST: num(item.igstPercent),
      DiscountTypeUID: item.discountTypeUID === undefined || item.discountTypeUID === null ? null : parseInt(String(item.discountTypeUID), 10) || 0,
      Discount: num(item.discount),
      UnitPrice: unitPrice,
      SellingPrice: item.sellingPrice === undefined || item.sellingPrice === null ? unitPrice : num(item.sellingPrice),
      DistributionMode: item.isComposite ? (item.distributionMode ?? null) : null,
      TaxableAmount: num(item.line_total),
      CgstAmount: num(item.cgstAmount),
      SgstAmount: num(item.sgstAmount),
      IgstAmount: num(item.igstAmount),
      TaxAmount: num(item.taxAmount),
      DiscountAmount: num(item.discount_amount),
      NetAmount: num(item.net_total),
      IsCompliment: item.isCompliment === undefined || item.isCompliment === null ? 0 : parseInt(String(item.isCompliment), 10) || 0,
      BrandUID: optionalInt(item.brandUID),
      BrandName: optionalText(item.brandName, 150),
      VariantUID: optionalInt(item.variantUID),
      VariantLabel: optionalText(item.variantLabel, 200),
      UpdatedBy: userUID,
    };
  }

  // Columns only a new line gets
  private static newItemFields(item: ItemInput, transUID: number, financialYear: number, ctx: WriteContext): Row {
    const source = parseInt(String(item.sourceTransProdUID ?? 0), 10) || 0;
    return {
      OrgUID: ctx.orgUID,
      FinancialYear: financialYear,
      TransUID: transUID,
      ProductUID: productOf(item),
      PurchasePrice: num(item.purchasePrice),
      IsPurchasePriceIncl: (item.purchasePriceIsIncl ?? true) ? 1 : 0,
      MRP: num(item.mrp),
      QuantityConverted: 0,
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: ctx.userUID,
      SourceTransProdUID: source > 0 ? source : null,
    };
  }

  // _insertTransItems — lines without a product or quantity are skipped
  private static itemRows(items: ItemInput[], transUID: number, financialYear: number, ctx: WriteContext, offset = 0): Row[] {
    return items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => productOf(item) > 0 && num(item.quantity) > 0)
      .map(({ item, index }) => ({ ...TransactionEngineService.itemFields(item, offset + index + 1, ctx.userUID), ...TransactionEngineService.newItemFields(item, transUID, financialYear, ctx) }));
  }

  // _updateTransItems — lines are matched by product: removed ones are soft-deleted, kept ones updated, new ones inserted
  private async updateItems(trx: Knex.Transaction, ctx: WriteContext, transUID: number, amounts: TransAmounts): Promise<void> {
    const existing = new Set(await this.writes.liveProductUIDs(trx, ctx.orgUID, transUID));
    const submitted = amounts.items.map(productOf).filter((uid) => uid > 0);
    await this.writes.softDeleteItemsByProducts(trx, ctx.orgUID, transUID, [...existing].filter((uid) => !submitted.includes(uid)), ctx.userUID);
    await this.writes.clearSequences(trx, ctx.orgUID, transUID, [...existing].filter((uid) => submitted.includes(uid)));

    const newRows: Row[] = [];
    for (const [index, item] of amounts.items.entries()) {
      const productUID = productOf(item);
      if (productUID <= 0 || num(item.quantity) <= 0) continue;
      const fields = TransactionEngineService.itemFields(item, index + 1, ctx.userUID);
      if (existing.has(productUID)) await this.writes.updateItem(trx, ctx.orgUID, transUID, productUID, fields);
      else newRows.push({ ...fields, ...TransactionEngineService.newItemFields(item, transUID, amounts.financialYear, ctx) });
    }
    await this.writes.insertItems(trx, newRows);
  }

  // The customer / vendor must be one of the organisation's (CI3 accepted any party UID)
  private async checkParty(kind: DocumentKind, orgUID: number, partyUID: number): Promise<void> {
    if (partyUID <= 0) return;
    if (kind.partyType === "C" && !(await this.lookups.customerExists(orgUID, partyUID))) throw new CiValidationError("Customer not found.");
    if (kind.partyType === "S" && !(await this.lookups.vendorExists(orgUID, partyUID))) throw new CiValidationError("Vendor not found.");
  }

  // cachehelper->touchCustomer / touchVendor — the party's cache entry is refreshed (never fails a save)
  private async touchParty(kind: DocumentKind, orgUID: number, partyUID: number): Promise<void> {
    if (partyUID <= 0) return;
    if (kind.partyType === "S") {
      await this.vendorCache.refresh(orgUID, partyUID);
      return;
    }
    try {
      await this.customerCache.refresh(orgUID, (await this.orgSettings.get(orgUID)).OrgToken, partyUID);
    } catch (err) {
      this.logger.warn(`Customer cache refresh for ${partyUID} failed: ${(err as Error).message}`);
    }
  }

  // AdditionalCharges JSON
  private static postedCharges(form: Form): ChargeInput[] {
    return postJsonArray<ChargeInput>(form, "AdditionalCharges");
  }

  // Filter posted as JSON or as an object
  static postedFilter(value: unknown): TransFilter {
    if (value && typeof value === "object") return value as TransFilter;
    if (typeof value !== "string" || !value) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as TransFilter) : {};
    } catch {
      return {};
    }
  }
}
