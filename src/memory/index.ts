import { all, type Db, one, run, transaction } from "../store/db.js";

export type DocKind = "memory" | "goal";

export interface Doc {
  kind: DocKind;
  ref: string;
  scope: string;
  text: string;
  meta: Record<string, unknown>;
  updatedAt: string;
}

interface DocRow {
  id: number;
  kind: DocKind;
  ref: string;
  scope: string;
  text: string;
  meta: string;
  updated_at: string;
}

const CJK = /[⺀-鿿가-힯豈-﫿぀-ヿ]/u;

/** Puts spaces between CJK characters so the word tokenizer can match them. */
function segment(text: string): string {
  return text.replace(/[⺀-鿿가-힯豈-﫿぀-ヿ]/gu, " $& ");
}

function words(query: string): string[] {
  return query.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Searchable text for memory and finished Goals. The plain table is always kept; an FTS5 index
 * is added alongside it when this SQLite build has FTS5, and search falls back to substring
 * matching when it does not.
 */
export class SearchIndex {
  private fts = false;

  constructor(private readonly db: Db) {}

  /** Creates the FTS5 table if possible and backfills it. Returns whether FTS5 is in use. */
  init(): boolean {
    try {
      this.db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')",
      );
      this.fts = true;
    } catch {
      this.fts = false;
      return false;
    }
    const docs = one<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM memory_docs")?.n ?? 0;
    const indexed = one<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM memory_fts")?.n ?? 0;
    if (docs !== indexed) this.rebuild();
    return true;
  }

  get usesFts(): boolean {
    return this.fts;
  }

  private rebuild(): void {
    transaction(this.db, () => {
      this.db.exec("DELETE FROM memory_fts");
      for (const row of all<DocRow>(this.db, "SELECT * FROM memory_docs")) this.indexRow(row);
    });
  }

  private indexRow(row: DocRow): void {
    if (!this.fts) return;
    run(this.db, "INSERT INTO memory_fts (rowid, text) VALUES (:id, :text)", {
      id: row.id,
      text: segment(row.text),
    });
  }

  private unindex(id: number): void {
    if (this.fts) run(this.db, "DELETE FROM memory_fts WHERE rowid = :id", { id });
  }

  upsert(doc: Doc): void {
    transaction(this.db, () => {
      const existing = one<DocRow>(
        this.db,
        "SELECT * FROM memory_docs WHERE kind = :kind AND ref = :ref",
        { kind: doc.kind, ref: doc.ref },
      );
      if (existing) {
        this.unindex(existing.id);
        run(
          this.db,
          "UPDATE memory_docs SET scope = :scope, text = :text, meta = :meta, updated_at = :at WHERE id = :id",
          {
            id: existing.id,
            scope: doc.scope,
            text: doc.text,
            meta: JSON.stringify(doc.meta),
            at: doc.updatedAt,
          },
        );
        this.indexRow({ ...existing, text: doc.text });
        return;
      }
      run(
        this.db,
        "INSERT INTO memory_docs (kind, ref, scope, text, meta, updated_at) VALUES (:kind, :ref, :scope, :text, :meta, :at)",
        {
          kind: doc.kind,
          ref: doc.ref,
          scope: doc.scope,
          text: doc.text,
          meta: JSON.stringify(doc.meta),
          at: doc.updatedAt,
        },
      );
      const row = one<DocRow>(
        this.db,
        "SELECT * FROM memory_docs WHERE rowid = last_insert_rowid()",
      );
      if (row) this.indexRow(row);
    });
  }

  remove(kind: DocKind, ref: string): void {
    transaction(this.db, () => {
      const row = one<DocRow>(
        this.db,
        "SELECT * FROM memory_docs WHERE kind = :kind AND ref = :ref",
        { kind, ref },
      );
      if (!row) return;
      this.unindex(row.id);
      run(this.db, "DELETE FROM memory_docs WHERE id = :id", { id: row.id });
    });
  }

  /** Replaces every doc of `kind` in `scope` with `docs`. */
  replaceScope(kind: DocKind, scope: string, docs: Doc[]): void {
    transaction(this.db, () => {
      const keep = new Set(docs.map((d) => d.ref));
      for (const row of all<DocRow>(
        this.db,
        "SELECT * FROM memory_docs WHERE kind = :kind AND scope = :scope",
        { kind, scope },
      )) {
        if (!keep.has(row.ref)) this.remove(kind, row.ref);
      }
      for (const doc of docs) this.upsert(doc);
    });
  }

  has(kind: DocKind, ref: string): boolean {
    return Boolean(
      one(this.db, "SELECT 1 AS x FROM memory_docs WHERE kind = :kind AND ref = :ref", {
        kind,
        ref,
      }),
    );
  }

  docs(kind: DocKind, scope?: string): Doc[] {
    const rows = scope
      ? all<DocRow>(
          this.db,
          "SELECT * FROM memory_docs WHERE kind = :kind AND scope = :scope ORDER BY id",
          { kind, scope },
        )
      : all<DocRow>(this.db, "SELECT * FROM memory_docs WHERE kind = :kind ORDER BY id", { kind });
    return rows.map(toDoc);
  }

  /** Best matches first. An empty query returns the most recently updated docs. */
  search(
    query: string,
    options: { kinds: DocKind[]; scope?: string | undefined; limit: number },
  ): Doc[] {
    const tokens = words(query);
    const kinds = options.kinds.map((k) => `'${k}'`).join(", ");
    const scopeSql = options.scope ? "AND d.scope = :scope" : "";
    const params: Record<string, string | number> = { limit: options.limit };
    if (options.scope) params.scope = options.scope;
    if (tokens.length === 0) {
      return all<DocRow>(
        this.db,
        `SELECT d.* FROM memory_docs d WHERE d.kind IN (${kinds}) ${scopeSql} ORDER BY d.updated_at DESC, d.id DESC LIMIT :limit`,
        params,
      ).map(toDoc);
    }
    if (this.fts) {
      const match = tokens
        .map((token) =>
          CJK.test(token) ? `"${segment(token).trim().replace(/\s+/g, " ")}"` : `"${token}"*`,
        )
        .join(" OR ");
      try {
        return all<DocRow>(
          this.db,
          `SELECT d.* FROM memory_fts JOIN memory_docs d ON d.id = memory_fts.rowid
           WHERE memory_fts MATCH :match AND d.kind IN (${kinds}) ${scopeSql}
           ORDER BY rank, d.updated_at DESC LIMIT :limit`,
          { ...params, match },
        ).map(toDoc);
      } catch {
        // A query FTS5 cannot parse falls through to substring matching.
      }
    }
    return this.like(tokens, kinds, scopeSql, params, options.limit);
  }

  private like(
    tokens: string[],
    kinds: string,
    scopeSql: string,
    params: Record<string, string | number>,
    limit: number,
  ): Doc[] {
    const lowered = tokens.map((t) => t.toLowerCase());
    const conditions = lowered.map((_, i) => `lower(d.text) LIKE :t${i} ESCAPE '\\'`).join(" OR ");
    const bound: Record<string, string | number> = { ...params };
    for (const [i, t] of lowered.entries()) bound[`t${i}`] = `%${t.replace(/[\\%_]/g, "\\$&")}%`;
    delete bound.limit;
    const rows = all<DocRow>(
      this.db,
      `SELECT d.* FROM memory_docs d WHERE d.kind IN (${kinds}) ${scopeSql} AND (${conditions})`,
      bound,
    );
    return rows
      .map((row) => ({
        row,
        score: lowered.filter((t) => row.text.toLowerCase().includes(t)).length,
      }))
      .sort((a, b) => b.score - a.score || b.row.updated_at.localeCompare(a.row.updated_at))
      .slice(0, limit)
      .map((r) => toDoc(r.row));
  }
}

function toDoc(row: DocRow): Doc {
  return {
    kind: row.kind,
    ref: row.ref,
    scope: row.scope,
    text: row.text,
    meta: JSON.parse(row.meta) as Record<string, unknown>,
    updatedAt: row.updated_at,
  };
}
