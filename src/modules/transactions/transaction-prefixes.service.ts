import { Injectable } from "@nestjs/common";
import { DatabaseService } from "../../core/database/database.service";
import { WriteContext } from "../../core/request/write-context";
import { CiValidationError } from "../../core/response/ci-response";
import { postInt, postString } from "../../core/utils/form-values";
import { TransactionsRepository } from "./transactions.repository";

type Form = Record<string, unknown>;

const PREFIXES = "Settings.TransactionPrefixTbl";
const SEPARATORS = ["-", "/", "|", "_", "."];
const PADDINGS = ["1", "3", "5"];

const isSet = (value: unknown) => !!value && value !== "0";

// transPrefixValidateForm — the CI3 messages, for the fields that were posted
function prefixErrors(form: Form): string[] {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(form, key);
  const value = (key: string) => String(form[key] ?? "").trim();
  if (value("prefixSeparator") && !SEPARATORS.includes(value("prefixSeparator"))) return ["Invalid separator selected."];
  if (value("numberPadding") && !PADDINGS.includes(value("numberPadding"))) return ["Invalid number padding selected."];

  const errors: string[] = [];
  if (has("preModuleUID") && !(Number(value("preModuleUID")) > 0)) errors.push("The Module UID field is required.");
  if (has("transPrefixName")) {
    const name = value("transPrefixName");
    if (!name) errors.push("The Prefix Name field is required.");
    else if (name.length < 2) errors.push("The Prefix Name field must be at least 2 characters in length.");
    else if (name.length > 7) errors.push("The Prefix Name field cannot exceed 7 characters in length.");
  }
  if (value("fiscalYearFormat") && !["SHORT", "LONG"].includes(value("fiscalYearFormat"))) errors.push("The Year Format field must be one of: SHORT,LONG.");
  if (value("prefixSeparator").length > 5) errors.push("The Separator field cannot exceed 5 characters in length.");
  if (value("numberPadding") && Number.isNaN(Number(value("numberPadding")))) errors.push("The Number Pad field must contain only numbers.");
  if (isSet(form.includeShortName) && has("companyShortName")) {
    const short = value("companyShortName");
    if (!short) errors.push("The Short Name field is required.");
    else if (short.length > 10) errors.push("The Short Name field cannot exceed 10 characters in length.");
  }
  return errors;
}

/** The prefix modal of the transaction forms (CI3 Transactions prefix actions). */
@Injectable()
export class TransactionPrefixesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly reads: TransactionsRepository
  ) {}

  // getTransactionPrefixes — every live prefix of the organisation
  async list(orgUID: number) {
    return { Data: await this.reads.prefixes(orgUID) };
  }

  // addTransactionPrefix — stored for the posted module (CI3 left ModuleUID out, so the insert failed)
  async add(ctx: WriteContext, form: Form) {
    const moduleUID = postInt(form, "preModuleUID");
    const errors = prefixErrors(form);
    if (moduleUID <= 0 && errors.length === 0) errors.push("The Module UID field is required.");
    if (errors.length > 0) throw new CiValidationError(errors.join("\n"));
    const [prefixUID] = await this.db.write(PREFIXES).insert({ OrgUID: ctx.orgUID, ModuleUID: moduleUID, ...TransactionPrefixesService.fields(form), CreatedBy: ctx.userUID, UpdatedBy: ctx.userUID });
    const [prefix] = await this.reads.prefixes(ctx.orgUID, undefined, Number(prefixUID));
    return { Message: "Prefix added successfully.", PrefixUID: Number(prefixUID), PrefixData: prefix ?? null };
  }

  // updateTransactionPrefix
  async update(ctx: WriteContext, form: Form) {
    const prefixUID = postInt(form, "prePrefixUID");
    if (prefixUID <= 0) throw new CiValidationError("Invalid prefix.");
    const errors = prefixErrors(form);
    if (errors.length > 0) throw new CiValidationError(errors.join("\n"));
    await this.db.write(PREFIXES).where({ PrefixUID: prefixUID, OrgUID: ctx.orgUID }).update({ ...TransactionPrefixesService.fields(form), UpdatedBy: ctx.userUID });
    return { Message: "Prefix updated successfully." };
  }

  // deleteTransactionPrefix — soft delete
  async delete(ctx: WriteContext, form: Form) {
    const prefixUID = postInt(form, "prePrefixUID");
    if (prefixUID <= 0) throw new CiValidationError("Invalid prefix.");
    await this.db.write(PREFIXES).where({ PrefixUID: prefixUID, OrgUID: ctx.orgUID }).update({ IsDeleted: 1, IsActive: 0, UpdatedBy: ctx.userUID });
    return { Message: "Prefix deleted." };
  }

  // setDefaultTransactionPrefix — the default of its own module (CI3 cleared every module's default)
  async setDefault(ctx: WriteContext, form: Form) {
    const prefixUID = postInt(form, "prePrefixUID");
    if (prefixUID <= 0) throw new CiValidationError("Invalid prefix.");
    const [prefix] = await this.reads.prefixes(ctx.orgUID, undefined, prefixUID);
    if (!prefix) throw new CiValidationError("Invalid prefix.");
    await this.db.write.transaction(async (trx) => {
      await trx(PREFIXES).where({ OrgUID: ctx.orgUID, ModuleUID: prefix.ModuleUID }).update({ IsDefault: 0, UpdatedBy: ctx.userUID });
      await trx(PREFIXES).where({ PrefixUID: prefixUID, OrgUID: ctx.orgUID }).update({ IsDefault: 1, UpdatedBy: ctx.userUID });
    });
    return { Message: "Default prefix updated.", PrefixUID: prefixUID, AllPrefixData: { Data: await this.reads.prefixes(ctx.orgUID) } };
  }

  private static fields(form: Form) {
    const format = postString(form, "fiscalYearFormat");
    return {
      Name: String(postString(form, "transPrefixName") ?? "").toUpperCase(),
      IncludeFiscalYear: isSet(form.includeFiscalYear) ? 1 : 0,
      FiscalYearFormat: format === "SHORT" || format === "LONG" ? format : "SHORT",
      IncludeShortName: isSet(form.includeShortName) ? 1 : 0,
      ShortName: String(postString(form, "companyShortName") ?? "").slice(0, 20).toUpperCase(),
      Separator: postString(form, "prefixSeparator") || "-",
      NumberPadding: postInt(form, "numberPadding") || 1,
    };
  }
}
