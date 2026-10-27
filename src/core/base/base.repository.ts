import { Knex } from "knex";
import { DatabaseService } from "../database/database.service";

/** Helpers every repository shares, so list/search/translation logic is written once. */
export abstract class BaseRepository {
  constructor(protected readonly db: DatabaseService) {}

  protected get read(): Knex {
    return this.db.read;
  }

  /** Write connection, or the open transaction when the write is part of one. */
  protected writer(trx?: Knex.Transaction): Knex | Knex.Transaction {
    return trx ?? this.db.write;
  }

  /** CI3's group_start() + or_like(col, term, 'both') on several columns. */
  protected whereAnyLike(qb: Knex.QueryBuilder, columns: string[], term: string): void {
    qb.where((group) => {
      for (const column of columns) group.orWhere(column, "like", BaseRepository.likePattern(term));
    });
  }

  /** One column matching any of several values (group_start() + or_like per value). */
  protected whereLikeAnyOf(qb: Knex.QueryBuilder, column: string, values: string[]): void {
    qb.where((group) => {
      for (const value of values) group.orWhere(column, "like", BaseRepository.likePattern(value));
    });
  }

  /** %term% with LIKE wildcards in the term escaped, as CI3's like() does. */
  protected static likePattern(term: string): string {
    return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  }

  /**
   * Select a translatable column: COALESCE(translated, base) when a non-English language is asked for,
   * otherwise the base column — the same pattern CI3 uses with the *_Lang tables.
   */
  protected langColumn(useLang: boolean, translated: string, base: string, alias: string): Knex.Raw | string {
    return useLang ? this.read.raw("COALESCE(??, ??) AS ??", [translated, base, alias]) : `${base} as ${alias}`;
  }

  protected static useLang(langCode: string): boolean {
    return !!langCode && langCode !== "en";
  }

  protected static offset(pageNo: number, limit: number): number {
    return Math.max(0, (pageNo - 1) * limit);
  }
}
