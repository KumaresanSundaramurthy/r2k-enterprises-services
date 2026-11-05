import { Injectable } from "@nestjs/common";
import { nowDateTime, todayDate } from "../../common/utils/php-compat";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postJsonArray, postString } from "../../core/utils/form-values";
import { OrgInfoCacheService } from "../../libraries/org-info-cache/org-info-cache.service";
import { TransactionEngineService } from "../transactions/transaction-engine.service";
import { Form } from "../transactions/transaction-form";
import { TransactionsRepository } from "../transactions/transactions.repository";
import { PackingListLine, PackingListsRepository } from "./packing-lists.repository";

type Row = Record<string, unknown>;

const text = (form: Form, key: string): string => (postString(form, key) ?? "").trim();
const num = (value: unknown): number => Number(value ?? 0) || 0;

/**
 * Packing Lists (CI3 Packinglists controller, routes packing-list/...): one packing list per dispatching transaction
 * of any module (DC, invoice, ...). Its source transaction must belong to the org.
 */
@Injectable()
export class PackingListsService {
  constructor(
    private readonly lists: PackingListsRepository,
    private readonly reads: TransactionsRepository,
    private readonly engine: TransactionEngineService,
    private readonly orgInfo: OrgInfoCacheService
  ) {}

  // index — every packing list of the org (PLList)
  async getPageData(orgUID: number) {
    return { PLList: await this.lists.all(orgUID) };
  }

  // form — the source transaction and its lines, the saved packing list (if any) and the org header
  async getFormData(orgUID: number, transUID: number) {
    const source = await this.source(orgUID, transUID);
    const packingList = await this.lists.byTransaction(orgUID, transUID);
    const [srcItems, plItems, org] = await Promise.all([
      this.engine.items(orgUID, transUID),
      packingList ? this.lists.items(orgUID, Number(packingList.PackingListUID)) : Promise.resolve([]),
      this.orgInfo.get(orgUID),
    ]);
    return { SrcHeader: source, SrcItems: srcItems, PL: packingList, PLItems: plItems, OrgInfo: org };
  }

  // printPL — print data; with no saved packing list the transaction's own lines are printed
  async getPrintData(orgUID: number, transUID: number) {
    const source = await this.source(orgUID, transUID);
    const packingList = await this.lists.byTransaction(orgUID, transUID);
    const [items, org] = await Promise.all([
      packingList ? this.lists.items(orgUID, Number(packingList.PackingListUID)) : this.engine.items(orgUID, transUID),
      this.orgInfo.get(orgUID),
    ]);
    return { DCHeader: source, PL: packingList, PLItems: items, OrgInfo: org };
  }

  /**
   * save — PLUID 0 creates the transaction's packing list (numbered PL-001 ...), else updates it and replaces its
   * lines. items: JSON [{ TransProductUID, ProductUID, Quantity, PackageKind, NumberOfPackages, NetWeight, GrossWeight, CBM }].
   */
  async save(ctx: WriteContext, form: Form) {
    const transUID = postInt(form, "TransUID");
    if (transUID <= 0) throw new CiValidationError("Invalid source transaction.");
    if (!(await this.reads.find(ctx.orgUID, transUID, null))) throw new CiValidationError("Source transaction not found.");
    const header = {
      TransUID: transUID,
      PLDate: text(form, "PLDate") || todayDate(),
      VehicleNumber: text(form, "VehicleNumber") || null,
      LRNumber: text(form, "LRNumber") || null,
      TransporterName: text(form, "TransporterName") || null,
      Notes: text(form, "Notes") || null,
    };
    const lines: PackingListLine[] = [];
    for (const item of postJsonArray<Row>(form, "items")) {
      const transProductUID = Math.trunc(num(item.TransProductUID));
      const productUID = Math.trunc(num(item.ProductUID));
      if (transProductUID <= 0 || productUID <= 0) continue;
      const kind = String(item.PackageKind ?? "").trim();
      lines.push({
        TransProductUID: transProductUID,
        ProductUID: productUID,
        Quantity: num(item.Quantity),
        PackageKind: kind ? kind.slice(0, 100) : null,
        NumberOfPackages: Math.trunc(num(item.NumberOfPackages)),
        NetWeight: num(item.NetWeight),
        GrossWeight: num(item.GrossWeight),
        CBM: num(item.CBM),
      });
    }
    const packingListUID = await this.lists.transaction((trx) => this.lists.save(trx, ctx.orgUID, ctx.userUID, postInt(form, "PLUID"), header, lines, nowDateTime()));
    if (packingListUID <= 0) throw new CiValidationError("Packing list not found.");
    return { Message: "Packing list saved successfully.", PLUID: packingListUID, PrintURL: `/packing-list/${transUID}/print` };
  }

  // getTransactionById without a module — the org's live transaction of any kind
  private async source(orgUID: number, transUID: number): Promise<Row> {
    if (transUID <= 0) throw new CiValidationError("Invalid source transaction.");
    const source = await this.reads.find(orgUID, transUID, null);
    if (!source) throw new CiValidationError("Source transaction not found.");
    return source;
  }
}
