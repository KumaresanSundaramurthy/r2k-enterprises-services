import { Injectable } from "@nestjs/common";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { PURCHASE_ORDER } from "../transactions/transaction-kinds";

const TRANSITIONS: Record<string, string[]> = { Draft: ["Received"], Received: ["Closed", "Cancelled"], Closed: [], Cancelled: [] };

/** Purchase Orders page (CI3 Purchaseorders controller, module 104) on the shared transaction engine. */
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly audit: AuditLogService
  ) {}

  // index
  getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    return this.engine.pageData(PURCHASE_ORDER, orgUID, branchUID, userUID, tab, search);
  }

  // create / edit form data; edit adds the order, its lines, the vendor's address, files and charges
  async getFormData(orgUID: number, langCode: string, transUID: number) {
    const basics = await this.engine.formBasics(PURCHASE_ORDER, orgUID, langCode, "none");
    if (transUID <= 0) return { ...basics, TransactionCharges: [], IsEditMode: false };
    const order = await this.engine.document(PURCHASE_ORDER, orgUID, transUID, langCode);
    const [items, address, charges, files] = await Promise.all([
      this.engine.items(orgUID, transUID),
      this.engine.vendorAddress(Number(order.PartyUID), langCode),
      this.engine.chargesOf(orgUID, transUID),
      this.engine.attachmentsOf(orgUID, transUID),
    ]);
    return { ...basics, POData: order, POItems: items, VendorAddr: address, TransactionCharges: charges, POAttachments: files, IsEditMode: true };
  }

  // addPurchaseOrder
  async add(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const saved = await this.engine.create(PURCHASE_ORDER, ctx, form, PurchaseOrdersService.input(form), files);
    await this.log(ctx, "ADD_PURCHASE_ORDER", saved.transUID, saved.uniqueNumber ?? "", `Created purchase order ${saved.uniqueNumber ?? ""}`);
    return { Message: "Purchase order created successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // updatePurchaseOrder — a finalised draft may come back with a new TransUID
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const saved = await this.engine.update(PURCHASE_ORDER, ctx, form, PurchaseOrdersService.input(form), files);
    const number = saved.uniqueNumber ?? saved.previousNumber ?? "";
    await this.log(ctx, "UPDATE_PURCHASE_ORDER", saved.transUID, number, `Updated purchase order ${number}`);
    return { Message: "Purchase order updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // deletePurchaseOrder — answers with the list page the user was on
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    await this.engine.delete(PURCHASE_ORDER, ctx, transUID);
    await this.log(ctx, "DELETE_PURCHASE_ORDER", transUID, "", `Deleted purchase order #${transUID}`);
    return { Message: "Purchase order deleted successfully.", ...(await this.engine.listAfterChange(PURCHASE_ORDER, ctx, form)) };
  }

  // duplicatePurchaseOrder — a Draft copy dated today
  async duplicate(ctx: WriteContext, form: Form) {
    const copy = await this.engine.duplicate(PURCHASE_ORDER, ctx, postInt(form, "TransUID"), "Invalid purchase order.");
    await this.log(ctx, "DUPLICATE_PURCHASE_ORDER", copy.transUID, copy.uniqueNumber, `Duplicated purchase order ${copy.uniqueNumber}`);
    return { Message: `Purchase order duplicated as ${copy.uniqueNumber}.`, TransUID: copy.transUID, EditURL: `/purchaseorders/edit/${copy.transUID}` };
  }

  // updatePurchaseOrderStatus — Draft → Received; Received → Closed / Cancelled
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = (postString(form, "Status") ?? "").trim();
    if (transUID <= 0) throw new CiValidationError("Invalid purchase order.");
    const existing = await this.engine.changeStatus(PURCHASE_ORDER, ctx, transUID, status, TRANSITIONS, "Invalid purchase order.");
    const ref = existing.UniqueNumber ? `${existing.UniqueNumber} ` : "";
    const messages: Record<string, string> = {
      Cancelled: `Purchase order ${ref}cancelled successfully.`,
      Received: `Purchase order ${ref}marked as received.`,
      Closed: `Purchase order ${ref}closed.`,
    };
    await this.audit.log(ctx, {
      action: "UPDATE_PO_STATUS",
      entityType: "PurchaseOrder",
      entityUID: transUID,
      entityRef: String(existing.UniqueNumber ?? ""),
      summary: `Updated purchase order status #${transUID}`,
      module: "PurchaseOrders",
      category: "TRANSACTION",
      details: { NewStatus: status },
    });
    return { Message: messages[status] ?? "Status updated.", NewStatus: status };
  }

  static input(form: Form): SaveInput {
    return { partyUID: postInt(form, "vendorSearch"), validityDate: postString(form, "expectedDate") || null, validityDays: null };
  }

  private log(ctx: WriteContext, action: string, entityUID: number, entityRef: string, summary: string) {
    return this.audit.log(ctx, { action, entityType: "PurchaseOrder", entityUID, entityRef, summary, module: "PurchaseOrders", category: "TRANSACTION" });
  }
}
