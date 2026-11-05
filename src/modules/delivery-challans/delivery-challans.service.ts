import { Injectable } from "@nestjs/common";
import { nowDateTime } from "../../common/utils/php-compat";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postJsonArray, postString } from "../../core/utils/form-values";
import { AuditLogService } from "../../libraries/audit-log/audit-log.service";
import { StockLedgerService } from "../../libraries/stock-ledger/stock-ledger.service";
import { SalesRepository } from "../invoices/sales.repository";
import { DocumentEffectsService } from "../transactions/document-effects.service";
import { UploadedFile } from "../transactions/transaction-attachments.service";
import { SaveInput, TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { DELIVERY_CHALLAN, SALES_ORDER } from "../transactions/transaction-kinds";
import { TransactionsRepository } from "../transactions/transactions.repository";

type Row = Record<string, unknown>;

// Challan statuses whose goods went out (their stock is reversed on delete)
const STOCK_OUT = ["Dispatched", "Delivered", "Partially Returned", "Converted"];
const RETURNABLE = ["Returnable", "Job Work"];
const PARTIAL_RETURN = ["Dispatched", "Partially Returned"];

/**
 * Delivery Challans page (CI3 Deliverychallans controller, module 112) on the shared transaction engine. A saved
 * challan takes stock out; returnable / job-work challans bring it back when Returned or partially returned.
 */
@Injectable()
export class DeliveryChallansService {
  constructor(
    private readonly engine: TransactionEngineService,
    private readonly effects: DocumentEffectsService,
    private readonly stock: StockLedgerService,
    private readonly reads: TransactionsRepository,
    private readonly sales: SalesRepository,
    private readonly audit: AuditLogService
  ) {}

  // index
  getPageData(orgUID: number, branchUID: number, userUID: number, tab: string, search: string) {
    return this.engine.pageData(DELIVERY_CHALLAN, orgUID, branchUID, userUID, tab, search);
  }

  // create / edit form data. New: from a sales order (fromSalesOrder) or a challan to clone (fromClone)
  async getFormData(orgUID: number, langCode: string, transUID: number, fromSalesOrderUID: number, fromCloneUID: number) {
    const basics = await this.engine.formBasics(DELIVERY_CHALLAN, orgUID, langCode, "list");
    if (transUID > 0) {
      const challan = await this.engine.document(DELIVERY_CHALLAN, orgUID, transUID, langCode);
      const [items, address, files, charges] = await Promise.all([
        this.engine.items(orgUID, transUID),
        this.engine.customerAddress(Number(challan.PartyUID), langCode),
        this.engine.attachmentsOf(orgUID, transUID),
        this.engine.chargesOf(orgUID, transUID),
      ]);
      return { ...basics, DCData: challan, DCItems: items, CustAddr: address, DCAttachments: files, TransactionCharges: charges, IsEditMode: true };
    }
    const source = async (kind: typeof SALES_ORDER, sourceUID: number) => {
      if (sourceUID <= 0) return [null, []] as const;
      const doc = await this.engine.document(kind, orgUID, sourceUID).catch(() => null);
      return [doc, doc ? await this.engine.items(orgUID, sourceUID) : []] as const;
    };
    const [[order, orderItems], [clone, cloneItems]] = await Promise.all([source(SALES_ORDER, fromSalesOrderUID), source(DELIVERY_CHALLAN, fromCloneUID)]);
    return {
      ...basics,
      FromSOUID: fromSalesOrderUID,
      SOSourceData: order,
      SOSourceItems: orderItems,
      FromCloneUID: fromCloneUID,
      CloneData: clone,
      CloneItems: cloneItems,
      TransactionCharges: [],
      IsEditMode: false,
    };
  }

  /**
   * addDeliveryChallan — a challan from a sales order keeps the order's customer and may only dispatch the order's
   * items up to its quantities; when saved it marks the order Converted. A saved challan takes its stock out.
   */
  async add(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    const customerUID = postInt(form, "customerSearch");
    const fromOrderUID = postInt(form, "fromSOUID");
    if (fromOrderUID > 0) await this.checkAgainstOrder(ctx.orgUID, fromOrderUID, customerUID, form);
    const saved = await this.engine.create(DELIVERY_CHALLAN, ctx, form, DeliveryChallansService.input(form), files, async (trx, doc) => {
      if (doc.isDraft) return;
      if (fromOrderUID > 0) {
        await this.engine.setStatus(trx, ctx.orgUID, fromOrderUID, "Converted", ctx.userUID);
        await this.engine.recordConversion(trx, {
          OrgUID: ctx.orgUID,
          SourceTransUID: fromOrderUID,
          SourceModuleUID: SALES_ORDER.moduleUID,
          TargetTransUID: doc.transUID,
          TargetModuleUID: DELIVERY_CHALLAN.moduleUID,
          ConversionType: "OrderToChallan",
          CreatedBy: ctx.userUID,
        });
      }
      await this.effects.saveStock(trx, DELIVERY_CHALLAN, ctx, doc.transUID, doc.amounts.items);
    });
    if (!saved.isDraft) await this.effects.refreshLineProducts(ctx.orgUID, saved.amounts.items);
    await this.log(ctx, "ADD_DELIVERY_CHALLAN", saved.transUID, saved.uniqueNumber ?? "", `Created delivery challan ${saved.uniqueNumber ?? ""}`);
    return { Message: "Delivery challan created successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  /**
   * updateDeliveryChallan — always updated in place. Saving (not as a draft) takes the stock out; a challan that was
   * Dispatched has its earlier movement reversed first.
   */
  async update(ctx: WriteContext, form: Form, files: UploadedFile[]) {
    let reversed: number[] = [];
    const saved = await this.engine.update(DELIVERY_CHALLAN, ctx, form, DeliveryChallansService.input(form), files, {
      inside: async (trx, doc) => {
        if (doc.isDraft) return;
        if (doc.existing.DocStatus === "Dispatched") reversed = await this.effects.reverseStock(trx, DELIVERY_CHALLAN, ctx, doc.transUID);
        await this.effects.saveStock(trx, DELIVERY_CHALLAN, ctx, doc.activeUID, doc.amounts.items);
      },
    });
    if (!saved.isDraft) await this.effects.refreshLineProducts(ctx.orgUID, saved.amounts.items, reversed);
    const number = saved.uniqueNumber ?? saved.previousNumber ?? "";
    await this.log(ctx, "UPDATE_DELIVERY_CHALLAN", saved.transUID, number, `Updated delivery challan ${number}`);
    return { Message: "Delivery challan updated successfully.", TransUID: saved.transUID, Token: saved.token };
  }

  // deleteDeliveryChallan — a challan whose goods went out has its stock reversed; answers with the list page
  async delete(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    let reversed: number[] = [];
    await this.engine.delete(DELIVERY_CHALLAN, ctx, transUID, async (trx, existing) => {
      if (STOCK_OUT.includes(String(existing.DocStatus))) reversed = await this.effects.reverseStock(trx, DELIVERY_CHALLAN, ctx, transUID);
    });
    await this.effects.refreshProducts(ctx.orgUID, reversed);
    await this.log(ctx, "DELETE_DELIVERY_CHALLAN", transUID, "", `Deleted delivery challan #${transUID}`);
    return { Message: "Delivery challan deleted successfully.", ...(await this.engine.listAfterChange(DELIVERY_CHALLAN, ctx, form)) };
  }

  // duplicateDeliveryChallan — a Draft copy dated today
  async duplicate(ctx: WriteContext, form: Form) {
    const copy = await this.engine.duplicate(DELIVERY_CHALLAN, ctx, postInt(form, "TransUID"), "Invalid delivery challan.");
    await this.log(ctx, "DUPLICATE_DELIVERY_CHALLAN", copy.transUID, copy.uniqueNumber, `Duplicated delivery challan ${copy.uniqueNumber}`);
    return { Message: `Delivery challan cloned as ${copy.uniqueNumber}.`, TransUID: copy.transUID, EditURL: `/deliverychallan/${copy.transUID}/edit` };
  }

  /**
   * updateDeliveryChallanStatus — Draft → Dispatched; Dispatched → Delivered / Cancelled (non-returnable) or
   * Returned / Cancelled (returnable, job work). Goods coming back (Returned / Cancelled from Dispatched) restore
   * their stock. Answers with the list page.
   */
  async updateStatus(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    const status = (postString(form, "Status") ?? "").trim();
    if (transUID <= 0) throw new CiValidationError("Invalid delivery challan.");
    const current = await this.engine.document(DELIVERY_CHALLAN, ctx.orgUID, transUID);
    const returnable = RETURNABLE.includes(String(current.DocType ?? "Non-Returnable"));
    const transitions: Record<string, string[]> = {
      Draft: ["Dispatched"],
      Dispatched: returnable ? ["Returned", "Cancelled"] : ["Delivered", "Cancelled"],
      Delivered: [],
      Returned: [],
      Converted: [],
      Cancelled: [],
    };
    let reversed: number[] = [];
    const existing = await this.engine.changeStatus(DELIVERY_CHALLAN, ctx, transUID, status, transitions, "Invalid delivery challan.", {
      inside: async (trx, challan) => {
        if (["Returned", "Cancelled"].includes(status) && challan.DocStatus === "Dispatched") reversed = await this.effects.reverseStock(trx, DELIVERY_CHALLAN, ctx, transUID);
      },
    });
    await this.effects.refreshProducts(ctx.orgUID, reversed);
    await this.audit.log(ctx, {
      action: "UPDATE_DC_STATUS",
      entityType: "DeliveryChallan",
      entityUID: transUID,
      entityRef: String(existing.UniqueNumber ?? ""),
      summary: `Updated delivery challan status #${transUID}`,
      module: "DeliveryChallans",
      category: "TRANSACTION",
      details: { NewStatus: status },
    });
    return { Message: `Status updated to ${status}.`, NewStatus: status, ...(await this.engine.listAfterChange(DELIVERY_CHALLAN, ctx, form)) };
  }

  // getPartialReturnData — each line's dispatched, returned and still-out quantity (Dispatched / Partially Returned only)
  async partialReturnData(orgUID: number, transUID: number) {
    if (transUID <= 0) throw new CiValidationError("Invalid DC.");
    const challan = await this.engine.document(DELIVERY_CHALLAN, orgUID, transUID);
    if (!PARTIAL_RETURN.includes(String(challan.DocStatus))) throw new CiValidationError("Partial return is only allowed for Dispatched or Partially Returned challans.");
    const [items, returned] = await Promise.all([this.engine.items(orgUID, transUID), this.sales.challanReturned(orgUID, transUID)]);
    return {
      DC: { UniqueNumber: challan.UniqueNumber, DocStatus: challan.DocStatus },
      Items: items.map((item) => {
        const dispatched = Number(item.Quantity) || 0;
        const already = returned.get(Number(item.TransProdUID)) ?? 0;
        return {
          TransProdUID: Number(item.TransProdUID),
          ProductUID: Number(item.ProductUID),
          ProductName: item.ProductName,
          UnitName: item.PrimaryUnitName ?? "",
          DispatchedQty: dispatched,
          ReturnedQty: already,
          StillOut: Math.max(0, dispatched - already),
        };
      }),
    };
  }

  /**
   * partialReturn — ReturnItems [{ TransProdUID, ReturnQty }]: each return is recorded and its stock comes back in
   * (a ledger IN row on the challan, so deleting the challan nets it out). The challan becomes Returned when nothing
   * is still out, else Partially Returned. Answers with the list page.
   */
  async partialReturn(ctx: WriteContext, form: Form) {
    const { orgUID, userUID } = ctx;
    const transUID = postInt(form, "TransUID");
    const notes = (postString(form, "Notes") ?? "").trim();
    if (transUID <= 0) throw new CiValidationError("Invalid DC.");
    const returns = postJsonArray<Row>(form, "ReturnItems");
    if (returns.length === 0) throw new CiValidationError("No items to return.");
    const challan = await this.engine.document(DELIVERY_CHALLAN, orgUID, transUID);
    if (!PARTIAL_RETURN.includes(String(challan.DocStatus))) throw new CiValidationError(`Cannot process return for status: ${challan.DocStatus}`);
    const items = await this.engine.items(orgUID, transUID);
    const byLine = new Map(items.map((item) => [Number(item.TransProdUID), item]));
    const now = nowDateTime();

    const status = await this.sales.transaction(async (trx) => {
      const returned = await this.sales.challanReturned(orgUID, transUID, trx);
      let anyReturn = false;
      for (const entry of returns) {
        const transProdUID = Math.trunc(Number(entry.TransProdUID ?? 0) || 0);
        const qty = Number(entry.ReturnQty ?? 0) || 0;
        if (qty <= 0) continue;
        const item = byLine.get(transProdUID);
        if (!item) throw new CiValidationError(`Invalid item reference: TransProdUID=${transProdUID}`);
        const stillOut = (Number(item.Quantity) || 0) - (returned.get(transProdUID) ?? 0);
        if (qty > stillOut + 0.001) throw new CiValidationError(`"${item.ProductName}": return qty (${qty}) exceeds quantity still out (${stillOut}).`);
        await this.sales.insertChallanReturn(trx, { TransUID: transUID, TransProdUID: transProdUID, ProductUID: Number(item.ProductUID), OrgUID: orgUID, ReturnedQty: qty, ReturnedOn: now, Notes: notes || null, IsDeleted: 0, CreatedBy: userUID });
        await this.stock.apply(trx, { orgUID, userUID, productUID: Number(item.ProductUID), variantUID: 0, transUID, moduleUID: DELIVERY_CHALLAN.moduleUID, movementType: "IN", quantity: qty, unitCost: 0, transProdUID });
        anyReturn = true;
      }
      if (!anyReturn) throw new CiValidationError("No valid return quantities provided.");
      const stillOut = items.some((item) => {
        const line = Number(item.TransProdUID);
        const batch = returns.find((entry) => Math.trunc(Number(entry.TransProdUID ?? 0)) === line);
        return (returned.get(line) ?? 0) + (Number(batch?.ReturnQty ?? 0) || 0) < (Number(item.Quantity) || 0) - 0.001;
      });
      const newStatus = stillOut ? "Partially Returned" : "Returned";
      await this.engine.setStatus(trx, orgUID, transUID, newStatus, userUID);
      return newStatus;
    });
    await this.effects.refreshProducts(orgUID, items.map((item) => Number(item.ProductUID)));
    return { Message: `Return recorded. Status updated to ${status}.`, NewStatus: status, ...(await this.engine.listAfterChange(DELIVERY_CHALLAN, ctx, form)) };
  }

  // convertChallanToInvoice — a Delivered challan is marked Converted; the invoice form continues from it (RedirectURL)
  async convert(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Invalid delivery challan.");
    const existing = await this.engine.document(DELIVERY_CHALLAN, ctx.orgUID, transUID);
    if (existing.DocStatus !== "Delivered") throw new CiValidationError("Only Delivered challans can be converted to an Invoice.");
    await this.engine.changeStatus(DELIVERY_CHALLAN, ctx, transUID, "Converted", { Delivered: ["Converted"] }, "Invalid delivery challan.");
    await this.log(ctx, "CONVERT_DC_TO_INVOICE", transUID, String(existing.UniqueNumber ?? ""), `Converted delivery challan ${existing.UniqueNumber ?? ""} to invoice`);
    return { Message: "Challan marked as converted.", RedirectURL: `/invoices/create?fromChallan=${transUID}` };
  }

  static input(form: Form): SaveInput {
    return {
      partyUID: postInt(form, "customerSearch"),
      validityDate: null,
      validityDays: null,
      extraDetail: { ExpectedDeliveryDate: postString(form, "returnDate") || null, DeliveryByDate: postString(form, "deliveryBy") || null },
    };
  }

  // A challan from a sales order: same customer, only the order's items, never more than ordered
  private async checkAgainstOrder(orgUID: number, orderUID: number, customerUID: number, form: Form): Promise<void> {
    const order = await this.reads.find(orgUID, orderUID, SALES_ORDER.moduleUID);
    const orderItems = order ? await this.engine.items(orgUID, orderUID) : [];
    if (order && Number(order.PartyUID) !== customerUID) throw new CiValidationError("Customer cannot be changed on a challan linked to a Sales Order.");
    const ordered = new Map(orderItems.map((item) => [Number(item.ProductUID), Number(item.Quantity) || 0]));
    for (const item of postJsonArray<Row>(form, "Items")) {
      const productUID = Math.trunc(Number(item.productUID ?? item.id ?? 0) || 0);
      const name = String(item.itemName ?? "Unknown");
      if (!ordered.has(productUID)) throw new CiValidationError(`Item "${name}" is not part of the Sales Order and cannot be dispatched.`);
      const qty = Number(item.quantity ?? 0) || 0;
      if (qty > ordered.get(productUID)!) throw new CiValidationError(`Quantity for "${name}" (${qty}) exceeds the Sales Order quantity (${ordered.get(productUID)}).`);
    }
  }

  private log(ctx: WriteContext, action: string, entityUID: number, entityRef: string, summary: string) {
    return this.audit.log(ctx, { action, entityType: "DeliveryChallan", entityUID, entityRef, summary, module: "DeliveryChallans", category: "TRANSACTION" });
  }
}
