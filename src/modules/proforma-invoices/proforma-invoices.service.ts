import { Injectable } from "@nestjs/common";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { PROFORMA_INVOICE } from "../transactions/transaction-kinds";

const TRANSITIONS: Record<string, string[]> = {
  Draft: ["Sent"],
  Sent: ["Converted", "Expired", "Cancelled"],
  Expired: ["Sent"],
  Converted: [],
  Cancelled: [],
};

/** Pro Forma Invoices page (CI3 Proformainvoices controller, routes proforma/..., module 113) on the shared engine. */
@Injectable()
export class ProformaInvoicesService {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly audit: AuditLogService
  ) {}

  // index
  getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    return this.engine.pageData(PROFORMA_INVOICE, orgUID, branchUID, userUID, tab, search);
  }

  // create / edit form data (edit: PFData, PFItems, CustAddr, PFAttachments, TransactionCharges)
  async getFormData(orgUID: number, langCode: string, transUID: number) {
    const basics = await this.engine.formBasics(PROFORMA_INVOICE, orgUID, langCode, "list");
    if (transUID <= 0) return { ...basics, TransactionCharges: [], IsEditMode: false };
    const proforma = await this.engine.document(PROFORMA_INVOICE, orgUID, transUID, langCode);
    const [items, address, files, charges] = await Promise.all([
      this.engine.items(orgUID, transUID),
      this.engine.customerAddress(Number(proforma.PartyUID), langCode),
      this.engine.attachmentsOf(orgUID, transUID),
      this.engine.chargesOf(orgUID, transUID),
    ]);
    return { ...basics, PFData: proforma, PFItems: items, CustAddr: address, PFAttachments: files, TransactionCharges: charges, IsEditMode: true };
  }

  // addProFormaInvoice
  async add(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const saved = await this.engine.create(PROFORMA_INVOICE, ctx, form, ProformaInvoicesService.input(form), files);
    await this.log(ctx, "ADD_PROFORMA", saved.transUID, saved.uniqueNumber ?? "", `Created proforma invoice ${saved.uniqueNumber ?? ""}`);
    return { Message: "Pro Forma Invoice created successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // updateProFormaInvoice — always updated in place
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const saved = await this.engine.update(PROFORMA_INVOICE, ctx, form, ProformaInvoicesService.input(form), files);
    const number = saved.uniqueNumber ?? saved.previousNumber ?? "";
    await this.log(ctx, "UPDATE_PROFORMA", saved.transUID, number, `Updated proforma invoice ${number}`);
    return { Message: "Pro Forma Invoice updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // deleteProFormaInvoice — answers with the list page
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Pro Forma ID is required.");
    await this.engine.delete(PROFORMA_INVOICE, ctx, transUID);
    await this.log(ctx, "DELETE_PROFORMA", transUID, "", `Deleted proforma invoice #${transUID}`);
    return { Message: "Pro Forma Invoice deleted successfully.", ...(await this.engine.listAfterChange(PROFORMA_INVOICE, ctx, form)) };
  }

  // duplicateProFormaInvoice — a Draft copy dated today
  async duplicate(ctx: WriteContext, form: Form) {
    const copy = await this.engine.duplicate(PROFORMA_INVOICE, ctx, postInt(form, "TransUID"), "Invalid Pro Forma Invoice.");
    await this.log(ctx, "DUPLICATE_PROFORMA", copy.transUID, copy.uniqueNumber, `Duplicated proforma invoice ${copy.uniqueNumber}`);
    return { Message: `Pro Forma duplicated as ${copy.uniqueNumber}.`, TransUID: copy.transUID, EditURL: `/proforma/${copy.transUID}/edit` };
  }

  // updateProFormaStatus — Draft → Sent; Sent → Converted / Expired / Cancelled; Expired → Sent. Answers with the list page
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = (postString(form, "Status") ?? "").trim();
    const existing = await this.engine.changeStatus(PROFORMA_INVOICE, ctx, transUID, status, TRANSITIONS, "Invalid Pro Forma Invoice.");
    await this.log(ctx, "UPDATE_PROFORMA_STATUS", transUID, String(existing.UniqueNumber ?? ""), `Updated proforma status #${transUID}`, { NewStatus: status });
    return { Message: `Status updated to ${status}.`, ...(await this.engine.listAfterChange(PROFORMA_INVOICE, ctx, form)) };
  }

  // convertProFormaToInvoice — a Sent pro forma is marked Converted; the invoice form continues from it (RedirectURL)
  async convert(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Invalid Pro Forma Invoice.");
    const existing = await this.engine.document(PROFORMA_INVOICE, ctx.orgUID, transUID);
    if (existing.DocStatus !== "Sent") throw new CiValidationError("Only a Sent Pro Forma can be converted to an Invoice.");
    await this.engine.changeStatus(PROFORMA_INVOICE, ctx, transUID, "Converted", { Sent: ["Converted"] }, "Invalid Pro Forma Invoice.");
    const number = String(existing.UniqueNumber ?? "");
    await this.log(ctx, "CONVERT_PROFORMA_TO_INVOICE", transUID, number, `Converted proforma ${number} to invoice`);
    return { Message: "Pro Forma marked as converted.", RedirectURL: `/invoices/create?fromProForma=${transUID}` };
  }

  private static input(form: Form): SaveInput {
    return { partyUID: postInt(form, "customerSearch"), validityDate: postString(form, "validityDate") || null, validityDays: null };
  }

  private log(ctx: WriteContext, action: string, entityUID: number, entityRef: string, summary: string, details: Record<string, unknown> = {}) {
    return this.audit.log(ctx, { action, entityType: "ProformaInvoice", entityUID, entityRef, summary, details, module: "ProformaInvoices", category: "TRANSACTION" });
  }
}
