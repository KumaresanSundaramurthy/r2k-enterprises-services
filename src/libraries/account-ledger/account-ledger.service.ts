import { Injectable } from "@nestjs/common";
import { Knex } from "knex";
import { WriteContext } from "../../core/request/write-context";
import { BALANCE_FY_START_MONTH } from "../../core/constants";
import { currentFinancialYear } from "../../core/utils/financial-year";
import { phpRound } from "../../common/utils/php-compat";
import { AccountLedgerRepository } from "./account-ledger.repository";

export type LedgerEntityType = "Customer" | "Vendor";

interface LedgerConfig {
  parentUID: number;
  parentName: string;
  parentType: string;
  codePrefix: string;
  entityColumn: "CustomerUID" | "VendorUID";
}

// CI3 Accountledger::getLedgerConfig
const LEDGER_CONFIG: Record<LedgerEntityType, LedgerConfig> = {
  Customer: { parentUID: 2, parentName: "Sundry Debtors", parentType: "Asset", codePrefix: "CST", entityColumn: "CustomerUID" },
  Vendor: { parentUID: 3, parentName: "Sundry Creditors", parentType: "Liability", codePrefix: "VND", entityColumn: "VendorUID" },
};

// CI3 Accountledger::_dec()
const LEDGER_DECIMALS = 4;

export interface LedgerOpening {
  name: string;
  openingBalance: number | string;
  openingBalanceType: string;
}

interface AuditDetails {
  field?: string;
  oldValue?: string;
  newValue?: string;
  amountChange?: unknown;
  balanceTypeChange?: string | null;
  reason?: string;
}

/**
 * Party ledgers in the chart of accounts (CI3 Accountledger library): create, update, deactivate and
 * audit. Runs inside the caller's transaction so the party and its ledger are saved or rolled back together.
 */
@Injectable()
export class AccountLedgerService {
  private parentChecked = new Set<number>();

  constructor(private readonly ledgers: AccountLedgerRepository) {}

  // createLedgerAccountingInfo — ledger under the parent group, its year opening, the entity mapping and an audit row.
  async createForEntity(trx: Knex.Transaction, ctx: WriteContext, entityType: LedgerEntityType, entityUID: number, opening: LedgerOpening) {
    const config = LEDGER_CONFIG[entityType];
    if (!this.parentChecked.has(config.parentUID)) {
      if (!(await this.ledgers.ledgerExists(config.parentUID, config.parentType))) {
        throw new Error(`Parent ledger (${config.parentName}) not found. Setup chart of accounts first.`);
      }
      this.parentChecked.add(config.parentUID);
    }

    const ledgerCode = `${config.codePrefix}-${String(entityUID).padStart(5, "0")}`;
    const ledgerUID = await this.ledgers.insertLedger(trx, {
      OrgUID: ctx.orgUID,
      LedgerCode: ledgerCode,
      LedgerName: opening.name,
      LedgerType: entityType,
      ParentLedgerUID: config.parentUID,
      OpeningBalance: opening.openingBalance,
      OpeningBalanceType: opening.openingBalanceType,
      CurrentBalance: Number(opening.openingBalance),
      CurrentBalanceType: opening.openingBalanceType,
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
    });

    await this.ledgers.insertYearOpening(trx, {
      OrgUID: ctx.orgUID,
      LedgerUID: ledgerUID,
      FinancialYear: currentFinancialYear(BALANCE_FY_START_MONTH),
      OpeningBalance: Number(opening.openingBalance),
      OpeningBalanceType: opening.openingBalanceType,
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
    });

    await this.ledgers.insertEntityMap(trx, {
      OrgUID: ctx.orgUID,
      LedgerUID: ledgerUID,
      EntityType: entityType,
      CustomerUID: entityType === "Customer" ? entityUID : null,
      VendorUID: entityType === "Vendor" ? entityUID : null,
      UserUID: null,
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
    });

    await this.audit(trx, ctx, entityType, entityUID, ledgerUID, "CREATE", {
      reason: `${entityType} ledger created`,
      amountChange: opening.openingBalance,
      balanceTypeChange: opening.openingBalanceType,
    });
    return ledgerUID;
  }

  /**
   * updateEntityLedgerInfo — renames the ledger and applies an opening-balance change. If the ledger has
   * journal entries, the current balance moves by the same difference instead of being reset.
   * Creates the ledger when the entity has none yet.
   */
  async updateForEntity(trx: Knex.Transaction, ctx: WriteContext, entityType: LedgerEntityType, entityUID: number, opening: LedgerOpening) {
    const config = LEDGER_CONFIG[entityType];
    const ledger = await this.ledgers.findEntityLedger(ctx.orgUID, config.entityColumn, entityUID, entityType, trx);
    if (!ledger || !ledger.LedgerUID) {
      return this.createForEntity(trx, ctx, entityType, entityUID, opening);
    }

    const ledgerUID = Number(ledger.LedgerUID);
    const update: Record<string, unknown> = {};
    const changes: AuditDetails[] = [];

    if (ledger.LedgerName !== opening.name) {
      update.LedgerName = opening.name;
      changes.push({ field: "LedgerName", oldValue: ledger.LedgerName, newValue: opening.name });
    }

    const newBalance = Number(opening.openingBalance) || 0;
    const newType = opening.openingBalanceType || "Debit";
    const oldBalance = Number(ledger.OpeningBalance) || 0;
    const oldType = ledger.OpeningBalanceType || "Debit";
    if (oldBalance !== newBalance || oldType !== newType) {
      update.OpeningBalance = newBalance;
      update.OpeningBalanceType = newType;

      if (!(await this.ledgers.hasTransactions(ctx.orgUID, ledgerUID, trx))) {
        update.CurrentBalance = newBalance;
        update.CurrentBalanceType = newType;
      } else {
        const sign = (amount: number, type: string) => (type === "Debit" ? amount : -amount);
        const current = sign(Number(ledger.CurrentBalance) || 0, ledger.CurrentBalanceType || "Debit");
        const result = current + (sign(newBalance, newType) - sign(oldBalance, oldType));
        update.CurrentBalance = phpRound(Math.abs(result), LEDGER_DECIMALS);
        update.CurrentBalanceType = result >= 0 ? "Debit" : "Credit";
      }
      changes.push({ field: "OpeningBalance", oldValue: `${oldBalance} ${oldType}`, newValue: `${newBalance} ${newType}` });

      await this.ledgers.updateYearOpening(trx, ctx.orgUID, ledgerUID, currentFinancialYear(BALANCE_FY_START_MONTH), {
        OpeningBalance: newBalance,
        OpeningBalanceType: newType,
      });
    }

    if (Object.keys(update).length > 0) {
      await this.ledgers.updateLedger(trx, ctx.orgUID, ledgerUID, update);
      for (const change of changes) {
        await this.audit(trx, ctx, entityType, entityUID, ledgerUID, "UPDATE", change);
      }
    }
    return ledgerUID;
  }

  // deactivateEntityLedger — only allowed while the ledger has no journal entries.
  async deactivateForEntity(trx: Knex.Transaction, ctx: WriteContext, entityType: LedgerEntityType, entityUID: number, ledgerUID: number) {
    if (await this.ledgers.hasTransactions(ctx.orgUID, ledgerUID, trx)) {
      throw new Error(`${entityType} ledger deactivation failed: Ledger has accounting transactions and cannot be deactivated`);
    }
    await this.ledgers.updateLedger(trx, ctx.orgUID, ledgerUID, { IsDeleted: 1, IsActive: 0 });
    await this.ledgers.deactivateEntityMap(trx, ctx.orgUID, ledgerUID, entityType);
    await this.audit(trx, ctx, entityType, entityUID, ledgerUID, "DELETE", {
      field: "LedgerStatus",
      reason: `${entityType} deleted`,
      oldValue: "Active",
      newValue: "Deactivated",
    });
  }

  async findEntityLedgerUID(orgUID: number, entityType: LedgerEntityType, entityUID: number, trx?: Knex.Transaction): Promise<number | null> {
    const ledger = await this.ledgers.findEntityLedger(orgUID, LEDGER_CONFIG[entityType].entityColumn, entityUID, entityType, trx);
    return ledger ? Number(ledger.LedgerUID) : null;
  }

  // logLedgerAudit
  private async audit(
    trx: Knex.Transaction,
    ctx: WriteContext,
    entityType: LedgerEntityType,
    entityUID: number,
    ledgerUID: number,
    changeType: "CREATE" | "UPDATE" | "DELETE",
    details: AuditDetails
  ) {
    await this.ledgers.insertAudit(trx, {
      OrgUID: ctx.orgUID,
      LedgerUID: ledgerUID,
      EntityType: entityType,
      ChangeType: changeType,
      FieldChanged: details.field ?? null,
      OldValue: details.oldValue ?? null,
      NewValue: details.newValue ?? null,
      ChangeDetails: JSON.stringify({
        AmountChange: details.amountChange ?? 0,
        BalanceTypeChange: details.balanceTypeChange ?? null,
        Reason: details.reason ?? "Ledger update",
        ReferenceId: null,
        EntityType: entityType,
      }),
      CreatedBy: ctx.userUID,
      UpdatedBy: ctx.userUID,
      IPAddress: ctx.ipAddress,
      UserAgent: ctx.userAgent,
      CustomerUID: entityType === "Customer" ? entityUID : null,
      VendorUID: entityType === "Vendor" ? entityUID : null,
      UserUID: null,
      BankUID: null,
    });
  }
}
