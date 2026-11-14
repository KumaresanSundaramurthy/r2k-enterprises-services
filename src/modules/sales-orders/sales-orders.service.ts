import { Injectable } from "@nestjs/common";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString, postValue } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { QUOTATION, SALES_ORDER } from "../transactions/transaction-kinds";

const TRANSITIONS: Record<string, string[]> = { Draft: ["Pending"], Pending: ["Cancelled"], Cancelled: [], Converted: [] };

/** Sales Orders page (CI3 Salesorders controller, module 102) on the shared transaction engine. */
@Injectable()
export class SalesOrdersService {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly audit: AuditLogService
  ) {}

  // index
  getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    return this.engine.pageData(SALES_ORDER, orgUID, branchUID, userUID, tab, search);
  }

  /**
   * create / edit form data. New: optionally from a quotation (fromQuotation → QuotationData, QuotationItems,
   * QuotationAttachments). Edit: the order, its lines, the customer's address, files and charges.
   */
  async getFormData(orgUID: number, langCode: string, transUID: number, fromQuotationUID: number) {
    if (transUID > 0) {
      const [order, basics, items, files, charges] = await Promise.all([
        this.engine.document(SALES_ORDER, orgUID, transUID, langCode),
        this.engine.formBasics(SALES_ORDER, orgUID, langCode, "single"),
        this.engine.items(orgUID, transUID),
        this.engine.attachmentsOf(orgUID, transUID),
        this.engine.chargesOf(orgUID, transUID),
      ]);
      const address = await this.engine.customerAddress(Number(order.PartyUID), langCode);
      return { ...basics, SOData: order, SOItems: items, CustAddr: address, SOAttachments: files, TransactionCharges: charges, IsEditMode: true };
    }
    const [basics, quotation] = await Promise.all([
      this.engine.formBasics(SALES_ORDER, orgUID, langCode),
      fromQuotationUID > 0 ? this.engine.document(QUOTATION, orgUID, fromQuotationUID).catch(() => null) : Promise.resolve(null),
    ]);
    let quotationItems: Record<string, unknown>[] = [];
    let quotationFiles: Record<string, unknown>[] = [];
    if (quotation) [quotationItems, quotationFiles] = await Promise.all([this.engine.items(orgUID, fromQuotationUID), this.engine.attachmentsOf(orgUID, fromQuotationUID)]);
    return {
      ...basics,
      FromQuotationUID: fromQuotationUID,
      QuotationData: quotation,
      QuotationItems: quotationItems,
      QuotationAttachments: quotationFiles,
      TransactionCharges: [],
      IsEditMode: false,
    };
  }

  // addSalesOrder — a saved (non-draft) order made from a quotation marks the quotation Converted
  async add(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const fromQuotationUID = postInt(form, "fromQuotationUID");
    const saved = await this.engine.create(SALES_ORDER, ctx, form, SalesOrdersService.input(form), files, async (trx, { transUID, isDraft }) => {
      if (fromQuotationUID <= 0 || isDraft) return;
      await this.engine.setStatus(trx, ctx.orgUID, fromQuotationUID, "Converted", ctx.userUID);
      await this.engine.recordConversion(trx, {
        OrgUID: ctx.orgUID,
        SourceTransUID: fromQuotationUID,
        SourceModuleUID: QUOTATION.moduleUID,
        TargetTransUID: transUID,
        TargetModuleUID: SALES_ORDER.moduleUID,
        ConversionType: "QuotToOrder",
        CreatedBy: ctx.userUID,
      });
    });
    await this.log(ctx, "ADD_SALES_ORDER", saved.transUID, saved.uniqueNumber ?? "", `Created sales order ${saved.uniqueNumber ?? ""}`);
    return { Message: "Sales order created successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // updateSalesOrder — a finalised draft may come back with a new TransUID
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const saved = await this.engine.update(SALES_ORDER, ctx, form, SalesOrdersService.input(form), files);
    const number = saved.uniqueNumber ?? saved.previousNumber ?? "";
    await this.log(ctx, "UPDATE_SALES_ORDER", saved.transUID, number, `Updated sales order ${number}`);
    return { Message: "Sales order updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // deleteSalesOrder — answers with the list page the user was on
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    await this.engine.delete(SALES_ORDER, ctx, transUID);
    await this.log(ctx, "DELETE_SALES_ORDER", transUID, "", `Deleted sales order #${transUID}`);
    return { Message: "Sales order deleted successfully.", ...(await this.engine.listAfterChange(SALES_ORDER, ctx, form)) };
  }

  // duplicateSalesOrder — a Draft copy dated today
  async duplicate(ctx: WriteContext, form: Form) {
    const copy = await this.engine.duplicate(SALES_ORDER, ctx, postInt(form, "TransUID"), "Invalid sales order.");
    await this.log(ctx, "DUPLICATE_SALES_ORDER", copy.transUID, copy.uniqueNumber, `Duplicated sales order ${copy.uniqueNumber}`);
    return { Message: `Sales order duplicated as ${copy.uniqueNumber}.`, TransUID: copy.transUID, EditURL: `/salesorders/edit/${copy.transUID}` };
  }

  // convertSalesOrderToInvoice / …ToDeliveryChallan — a Pending order becomes Converted; the target form follows
  async convert(ctx: WriteContext, form: Form, target: "Invoice" | "DeliveryChallan") {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Invalid sales order.");
    const order = await this.engine.document(SALES_ORDER, ctx.orgUID, transUID);
    if (order.DocStatus !== "Pending") {
      throw new CiValidationError(`Only Pending orders can be converted to ${target === "Invoice" ? "an Invoice" : "a Delivery Challan"}.`);
    }
    await this.engine.changeStatus(SALES_ORDER, ctx, transUID, "Converted", { Pending: ["Converted"] }, "Invalid sales order.");
    if (target === "Invoice") {
      const number = String(order.UniqueNumber ?? "");
      await this.log(ctx, "CONVERT_SO_TO_INVOICE", transUID, number, `Converted sales order ${number} to invoice`);
    }
    return {
      Message: "Sales order marked as converted.",
      RedirectURL: target === "Invoice" ? `/invoices/create?fromSalesOrder=${transUID}` : `/deliverychallan/create?fromSalesOrder=${transUID}`,
    };
  }

  // updateSalesOrderStatus — send a draft or cancel; answers with the list page
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = String(postValue(form, "Status") ?? "").trim();
    const existing = await this.engine.changeStatus(SALES_ORDER, ctx, transUID, status, TRANSITIONS, "Invalid sales order.");
    await this.audit.log(ctx, {
      action: "UPDATE_SO_STATUS",
      entityType: "SalesOrder",
      entityUID: transUID,
      entityRef: String(existing.UniqueNumber ?? ""),
      details: { NewStatus: status },
      summary: `Updated sales order status #${transUID}`,
      module: "SalesOrders",
      category: "TRANSACTION",
    });
    return { Message: "Status updated.", NewStatus: status, ...(await this.engine.listAfterChange(SALES_ORDER, ctx, form)) };
  }

  private static input(form: Form): SaveInput {
    return { partyUID: postInt(form, "customerSearch"), validityDate: postString(form, "deliveryDate") || null, validityDays: null };
  }

  private log(ctx: WriteContext, action: string, transUID: number, ref: string, summary: string) {
    return this.audit.log(ctx, { action, entityType: "SalesOrder", entityUID: transUID, entityRef: ref, summary, module: "SalesOrders", category: "TRANSACTION" });
  }
}
