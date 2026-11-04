import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Knex } from "knex";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { EntryAttachmentsService, UploadedFile } from "./entry-attachments.service";
import { EntryKind } from "./entry-kind";
import { EntryRepository } from "./entry.repository";

export interface PaymentInput {
  transUID: number;
  transNumber: string;
  amount: number;
  date: string;
  paymentTypeUID: number;
  bankAccountUID: number | null;
  notes: string | null;
  // Stored on the bank / cash book line only, as in CI3
  referenceNo: string | null;
  isFullyPaid: boolean;
  narration: string;
}

export interface RecordedPayment {
  paymentUID: number;
  paymentDate: string;
  transYear: number;
}

// Payment attachments: up to 3 files of 3 MB each, of these types (CI3 MY_Controller::_savePaymentAttachments)
const PAYMENT_FILE_LIMIT = 3;
const PAYMENT_FILE_MAX_BYTES = 3 * 1024 * 1024;
const PAYMENT_FILE_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/**
 * Payments of expenses and indirect income: the PaymentsTbl row and its bank / cash book line
 * (CI3 _insertExpensePayment / _insertIncomePayment / recordPayment), the payment history popup and payment files.
 */
@Injectable()
export class EntryPaymentsService {
  constructor(
    private readonly repo: EntryRepository,
    private readonly attachments: EntryAttachmentsService
  ) {}

  /**
   * Records one payment inside the caller's transaction. The first payment of a record takes the record's
   * number as its UniqueNumber, later ones get -1, -2, …; without a bank account the cash account is booked.
   */
  async record(trx: Knex.Transaction, kind: EntryKind, ctx: WriteContext, input: PaymentInput): Promise<RecordedPayment> {
    if (!input.paymentTypeUID) throw new CiValidationError("Please select a payment type.");
    const { orgUID, userUID } = ctx;
    const transYear = Number(input.date.slice(0, 4));
    const prefixUID = await this.repo.paymentPrefixUID(trx, orgUID, kind.prefixModuleUID);
    const paymentNumber = prefixUID ? await this.repo.nextPaymentNumber(trx, orgUID, prefixUID, transYear) : 0;
    const count = await this.repo.paymentCount(trx, orgUID, kind.sourceType, input.transUID);

    const paymentUID = await this.repo.insertPayment(trx, {
      OrgUID: orgUID,
      BranchUID: ctx.branchUID ?? 1,
      ReceiptToken: randomUUID(),
      PaymentDate: input.date,
      PaymentModuleUID: kind.paymentModuleUID,
      PrefixUID: prefixUID,
      PaymentNumber: paymentNumber,
      UniqueNumber: count === 0 ? input.transNumber : `${input.transNumber}-${count}`,
      TransYear: transYear,
      TransUID: input.transUID,
      ModuleUID: kind.moduleUID,
      SourceType: kind.sourceType,
      PartyType: null,
      PartyUID: null,
      PaymentTypeUID: input.paymentTypeUID,
      Amount: input.amount,
      BankAccountUID: input.bankAccountUID || null,
      Notes: input.notes,
      PaymentSource: "Create",
      PaymentDirection: kind.direction,
      IsFullyPaid: input.isFullyPaid ? 1 : 0,
      ExcessAmount: 0,
      IsActive: 1,
      IsDeleted: 0,
      CreatedBy: userUID,
      UpdatedBy: userUID,
    });

    const bankUID = input.bankAccountUID || (await this.repo.cashAccountUID(orgUID, trx));
    if (bankUID) {
      await this.repo.insertBankEntry(trx, {
        OrgUID: orgUID,
        BankAccountUID: bankUID,
        EntryDate: input.date,
        EntryType: kind.bankEntryType,
        Amount: input.amount,
        SourceType: kind.sourceType,
        SourceUID: input.transUID,
        ModuleUID: kind.moduleUID,
        ReferenceNo: input.referenceNo,
        Narration: input.narration,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: userUID,
        UpdatedBy: userUID,
      });
    }
    return { paymentUID, paymentDate: input.date, transYear };
  }

  // getPaymentHistory — amount, mode, date and reference of each payment
  async history(orgUID: number, kind: EntryKind, transUID: number, invalidMessage: string) {
    if (transUID <= 0) throw new CiValidationError(invalidMessage);
    const payments = await this.repo.payments(orgUID, kind.sourceType, transUID);
    return {
      Payments: payments.map((payment) => ({
        Amount: Number(payment.Amount),
        PaymentTypeName: payment.PaymentTypeName ?? "",
        CreatedOn: payment.CreatedOn ?? "",
        ReferenceNo: payment.ReferenceNo ?? "",
      })),
    };
  }

  // getPaymentAttachments — every payment's files, each with its payment's mode, amount and number
  async attachmentsOf(orgUID: number, kind: EntryKind, transUID: number, invalidMessage: string) {
    if (transUID <= 0) throw new CiValidationError(invalidMessage);
    const payments = await this.repo.payments(orgUID, kind.sourceType, transUID);
    const byUID = new Map(payments.map((payment) => [Number(payment.PaymentUID), payment]));
    const files = await this.repo.paymentAttachments(orgUID, [...byUID.keys()]);
    return {
      Attachments: files.map((file) => {
        const payment = byUID.get(Number(file.PaymentUID));
        return { ...file, PaymentTypeName: payment?.PaymentTypeName ?? null, PaymentAmount: payment?.Amount ?? null, PaymentUniqueNumber: payment?.UniqueNumber ?? null };
      }),
    };
  }

  // _savePaymentAttachments — files of another type or over 3 MB are skipped, like CI3
  async saveFiles(ctx: WriteContext, paymentUID: number, files: UploadedFile[]): Promise<void> {
    if (files.length === 0) return;
    const folder = `${await this.attachments.orgFolder(ctx.orgUID)}/payments/${paymentUID}`;
    for (const [index, file] of files.slice(0, PAYMENT_FILE_LIMIT).entries()) {
      if (file.size > PAYMENT_FILE_MAX_BYTES || !PAYMENT_FILE_TYPES.includes(file.mimetype)) continue;
      const path = await this.attachments.store(folder, file, index);
      if (!path) continue;
      await this.repo.insertPaymentAttachment({
        OrgUID: ctx.orgUID,
        PaymentUID: paymentUID,
        FileName: file.originalname,
        FilePath: path,
        FileType: file.mimetype,
        FileSize: file.size,
        SortOrder: index,
        IsActive: 1,
        IsDeleted: 0,
        CreatedBy: ctx.userUID,
      });
    }
  }
}
