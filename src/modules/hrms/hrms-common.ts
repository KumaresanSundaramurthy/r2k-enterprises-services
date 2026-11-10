import { ApiPropertyOptional } from "@nestjs/swagger";
import { Allow } from "class-validator";
import { phpDate } from "../../common/utils/php-compat";
import { OrgContextDto } from "../../core/dto/org-context.dto";
import { OrgUserBranchContextDto, OrgUserContextDto } from "../../core/dto/write-context.dto";

export type Row = Record<string, unknown>;
export type Filter = Record<string, string>;

export interface Page {
  Data: Row[];
  TotalCount: number;
  PageNo: number;
  RowLimit: number;
}

// The list filter posted as JSON (the CI3 JS sends Filter[...] or a JSON string) → flat string map
export function filterOf(value: unknown): Filter {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      raw = {};
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Filter = {};
  for (const [key, val] of Object.entries(raw as Row)) {
    if (val !== null && val !== undefined && typeof val !== "object") out[key] = String(val).trim();
  }
  return out;
}

// CI3 date('Y-m-d') / date('Y-m-d H:i:s'), in the organisation's timezone
export const todayIn = (timeZone: string) => phpDate("Y-m-d", new Date(), timeZone);
export const nowIn = (timeZone: string) => phpDate("Y-m-d H:i:s", new Date(), timeZone);

// A JSON array posted as a string, an array, or a PHP-style indexed object (Records[0][..]) → array
export function arrayOf<T = Row>(value: unknown): T[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") return Object.values(raw as Row) as T[];
  return [];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (value: unknown): value is string => typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));

// ── DTOs shared by the HRMS endpoints ───────────────────────────────────────────

// Paged list reads: GET with the page in the path or PageNo, Filter as JSON
export class HrmsListDto extends OrgContextDto {
  @ApiPropertyOptional({ type: Number, description: "1-based page number; used when it is not in the path" }) @Allow() PageNo?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Rows per page (default: the org's RowLimit)" }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ type: String, description: "List filter as JSON" }) @Allow() Filter?: unknown;
}

// Writes that answer with the refreshed list page (CI3's CurrentPage / Filter)
export class HrmsWriteDto extends OrgUserContextDto {
  @ApiPropertyOptional({ type: Number, description: "Page of the refreshed list (CI3 CurrentPage; default 1)" }) @Allow() CurrentPage?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Rows of the refreshed list (default: the org's RowLimit)" }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ type: String, description: "List filter (JSON or Filter[...])" }) @Allow() Filter?: unknown;
}

export class HrmsBranchWriteDto extends OrgUserBranchContextDto {
  @ApiPropertyOptional({ type: Number, description: "Page of the refreshed list (default 1)" }) @Allow() CurrentPage?: string | number;
  @ApiPropertyOptional({ type: Number, description: "Rows of the refreshed list (default: the org's RowLimit)" }) @Allow() RowLimit?: string | number;
  @ApiPropertyOptional({ type: String, description: "List filter (JSON or Filter[...])" }) @Allow() Filter?: unknown;
}

export const pageOf = (pathPage: string | undefined, dto: { PageNo?: string | number; CurrentPage?: string | number }) =>
  Math.max(1, Number(pathPage ?? dto.PageNo ?? dto.CurrentPage) || 1);

export const rowLimitOf = (dto: { RowLimit?: string | number }) => {
  const limit = Number(dto.RowLimit);
  return Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : undefined;
};
