import { Injectable } from "@nestjs/common";
import { todayDate } from "../../common/utils/php-compat";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { addDays, SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { QUOTATION } from "../transactions/transaction-kinds";

const TRANSITIONS: Record<string, string[]> = {
  Draft: ["Pending"],
  Pending: ["Accepted", "Cancelled"],
  Accepted: ["Pending", "Cancelled", "Converted"],
  Cancelled: [],
  Converted: [],
};

/** Quotations page (CI3 Quotations controller, module 101) on the shared transaction engine. */
@Injectable()
export class QuotationsService {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly audit: AuditLogService
  ) {}

  // index
  getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    return this.engine.pageData(QUOTATION, orgUID, branchUID, userUID, tab, search);
  }

  /**
   * create / edit form data. New: optionally pre-filled from another quotation (FromQuotation → CloneData,
   * CloneItems). Edit: the quotation, its lines, the customer's address, files and charges.
   */
  async getFormData(orgUID: number, langCode: string, transUID: number, fromQuotationUID: number) {
    const basics = await this.engine.formBasics(QUOTATION, orgUID, langCode);
    const validityDays = basics.QuotValidityDays >= 1 ? basics.QuotValidityDays : 7;
    const defaults = { DefaultValidityDays: validityDays, DefaultValidityDate: addDays(todayDate(), validityDays) };
    if (transUID > 0) {
      const quotation = await this.engine.document(QUOTATION, orgUID, transUID, langCode);
      const [items, files, charges, address] = await Promise.all([
        this.engine.items(orgUID, transUID),
        this.engine.attachmentsOf(orgUID, transUID),
        this.engine.chargesOf(orgUID, transUID),
        this.engine.customerAddress(Number(quotation.PartyUID), langCode),
      ]);
      return { ...basics, ...defaults, QuotData: quotation, QuotItems: items, CustAddr: address, QuotAttachments: files, TransactionCharges: charges, IsEditMode: true };
    }
    let clone = null;
    let cloneItems: Record<string, unknown>[] = [];
    if (fromQuotationUID > 0) {
      clone = await this.engine.document(QUOTATION, orgUID, fromQuotationUID).catch(() => null);
      if (clone) cloneItems = await this.engine.items(orgUID, fromQuotationUID);
    }
    return { ...basics, ...defaults, CloneData: clone, CloneItems: cloneItems, TransactionCharges: [], IsEditMode: false };
  }

  // addQuotation — the validity date is worked out from validityDays when not posted
  async add(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const saved = await this.engine.create(QUOTATION, ctx, form, QuotationsService.input(form), files);
    await this.log(ctx, "ADD", saved.transUID, saved.uniqueNumber ?? "", `Created quotation ${saved.uniqueNumber ?? ""}`);
    return { Message: "Quotation created successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // updateQuotation — a finalised draft may come back with a new TransUID
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const saved = await this.engine.update(QUOTATION, ctx, form, QuotationsService.input(form), files);
    const number = saved.uniqueNumber ?? saved.previousNumber ?? "";
    await this.log(ctx, "UPDATE", saved.transUID, number, `Updated quotation ${number}`);
    return { Message: "Quotation updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // deleteQuotation — answers with the list page the user was on
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    await this.engine.delete(QUOTATION, ctx, transUID);
    await this.log(ctx, "DELETE", transUID, "", `Deleted quotation #${transUID}`);
    return { Message: "Quotation deleted successfully.", ...(await this.engine.listAfterChange(QUOTATION, ctx, form)) };
  }

  // convertQuotationToInvoice — only the redirect; the quotation becomes Converted when the target is saved
  convert(form: Form) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Invalid quotation.");
    const target = String(postString(form, "ConvertTarget") ?? "Invoice").trim();
    const redirect = target === "SalesOrder" ? `/salesorders/create?fromQuotation=${transUID}` : `/invoices/create?fromQuotation=${transUID}`;
    return { Message: "Redirecting...", RedirectURL: redirect };
  }

  // updateQuotationStatus — send (Draft → Pending), accept, revert to open, cancel or mark converted
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = String(postValue(form, "Status") ?? "").trim();
    const existing = await this.engine.changeStatus(QUOTATION, ctx, transUID, status, TRANSITIONS, "Invalid quotation.");
    const number = String(existing.UniqueNumber ?? "");
    const label = number ? `${number} ` : "";
    let message = "Status updated.";
    if (status === "Cancelled") message = `Quotation ${label}cancelled successfully.`;
    else if (status === "Accepted") message = `Quotation ${label}marked as accepted.`;
    else if (status === "Pending" && existing.DocStatus === "Accepted") message = `Quotation ${label}reverted to open.`;
    else if (status === "Pending") message = `Quotation ${label}sent successfully.`;
    await this.log(ctx, "UPDATE", transUID, number, `Updated quotation status #${transUID}`, "_STATUS", { NewStatus: status });
    return { Message: message, NewStatus: status };
  }

  private static input(form: Form): SaveInput {
    const days = Number(postValue(form, "validityDays", 0)) || 0;
    const transDate = String(postString(form, "transDate") ?? "");
    let validityDate = postString(form, "validityDate");
    if (!validityDate && days > 0 && /^\d{4}-\d{2}-\d{2}$/.test(transDate)) validityDate = addDays(transDate, Math.trunc(days));
    return { partyUID: postInt(form, "customerSearch"), validityDate: validityDate || null, validityDays: days > 0 ? Math.trunc(days) : null };
  }

  private log(ctx: WriteContext, verb: string, transUID: number, ref: string, summary: string, suffix = "", details: Record<string, unknown> = {}) {
    return this.audit.log(ctx, {
      action: `${verb}_QUOTATION${suffix}`,
      entityType: "Quotation",
      entityUID: transUID,
      entityRef: ref,
      details,
      summary,
      module: "Quotations",
      category: "TRANSACTION",
    });
  }
}
