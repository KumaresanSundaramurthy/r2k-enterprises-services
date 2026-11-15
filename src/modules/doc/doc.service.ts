import { Injectable } from "@nestjs/common";
import { CiValidationError } from "../../core/response/ci-response";
import { TransactionPrintService } from "../transactions/transaction-print.service";
import { TransactionsRepository } from "../transactions/transactions.repository";

type Row = Record<string, unknown>;

// TransToken values are UUIDs; CI3 Doc accepted hex and dashes, at most 40 characters
const TOKEN = /^[0-9a-f-]{1,40}$/i;

/**
 * The public document link (CI3 Doc controller): anyone holding a document's TransToken can view or download its
 * A4 print. Drafts are never shared. Only the fields the page shows are returned (no OrgUID / TransUID).
 */
@Injectable()
export class DocService {
  constructor(
    private readonly reads: TransactionsRepository,
    private readonly print: TransactionPrintService
  ) {}

  static validToken(token: string): boolean {
    return TOKEN.test(token);
  }

  // Doc::view — the stub for the action bar and the print HTML
  async view(token: string) {
    if (!DocService.validToken(token)) throw new CiValidationError("Invalid document link.");
    const stub = await this.reads.stubByToken(token);
    if (!stub) throw new CiValidationError("Document not found. The link may be invalid or the document has been deleted.");
    if (stub.DocStatus === "Draft") throw new CiValidationError("This document is not yet finalized and cannot be shared.");

    const orgUID = Number(stub.OrgUID);
    const moduleUID = Number(stub.ModuleUID);
    const header = await this.reads.find(orgUID, Number(stub.TransUID), moduleUID);
    if (!header) throw new CiValidationError("Document not found. The link may be invalid or the document has been deleted.");

    return { Stub: DocService.publicStub(stub), PrintHtml: await this.print.a4Html(orgUID, moduleUID, header) };
  }

  // Doc::pdf — the A4 PDF and its file name; null when the link does not lead to a shareable document
  async pdf(token: string): Promise<{ bytes: Buffer; filename: string } | null> {
    if (!DocService.validToken(token)) return null;
    const stub = await this.reads.stubByToken(token);
    if (!stub || stub.DocStatus === "Draft") return null;
    const pdf = await this.print.pdf(Number(stub.OrgUID), Number(stub.TransUID), Number(stub.ModuleUID), "A4");
    if (!pdf || pdf.bytes.length === 0) return null;
    const number = String(stub.UniqueNumber ?? "");
    return { bytes: pdf.bytes, filename: number ? `${number.replace(/[^A-Za-z0-9_-]/g, "-")}.pdf` : "document.pdf" };
  }

  private static publicStub(stub: Row) {
    return {
      ModuleUID: Number(stub.ModuleUID),
      DocStatus: stub.DocStatus,
      TransType: stub.TransType,
      UniqueNumber: stub.UniqueNumber,
      NetAmount: stub.NetAmount,
      PaidAmount: stub.PaidAmount,
      BalanceAmount: stub.BalanceAmount,
    };
  }
}
