import { sha256Hex } from "./http";

export const GENESIS = "GENESIS";

export type AuditRole = "owner" | "manager" | "staff" | "system";

export interface AuditFields {
  at: number;
  actor: string;
  role: AuditRole;
  action: string;
  ref: number | null;
  detail: string;
}

export interface AuditEntry extends AuditFields {
  seq: number;
  prev_hash: string;
  hash: string;
}

export interface ChainHead {
  seq: number;
  hash: string;
}

/**
 * The exact string that is hashed. Anyone holding a CSV export can recompute it:
 * JSON array of [seq, at, actor, role, action, ref, detail, prev_hash].
 */
export function canonical(e: Omit<AuditEntry, "hash">): string {
  return JSON.stringify([e.seq, e.at, e.actor, e.role, e.action, e.ref, e.detail, e.prev_hash]);
}

/** Builds the next entries of the chain after `head` (null = empty chain). */
export async function extendChain(head: ChainHead | null, items: AuditFields[]): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  let seq = head?.seq ?? 0;
  let prev = head?.hash ?? GENESIS;
  for (const item of items) {
    seq += 1;
    const base = { ...item, detail: item.detail.slice(0, 400), seq, prev_hash: prev };
    const hash = await sha256Hex(canonical(base));
    out.push({ ...base, hash });
    prev = hash;
  }
  return out;
}

export function insertAudit(db: D1Database, sandboxId: string, entries: AuditEntry[]): D1PreparedStatement[] {
  return entries.map((e) =>
    db
      .prepare(
        `INSERT INTO audit_log (sandbox_id, seq, at, actor, role, action, ref, detail, prev_hash, hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      )
      .bind(sandboxId, e.seq, e.at, e.actor, e.role, e.action, e.ref, e.detail, e.prev_hash, e.hash),
  );
}

export function headQuery(db: D1Database, sandboxId: string): D1PreparedStatement {
  return db
    .prepare(`SELECT seq, hash FROM audit_log WHERE sandbox_id = ?1 ORDER BY seq DESC LIMIT 1`)
    .bind(sandboxId);
}

export interface ChainCheck {
  ok: boolean;
  count: number;
  head: string | null;
  brokenAt: number | null;
}

/** Recomputes every hash in order. */
export async function verifyChain(entries: AuditEntry[]): Promise<ChainCheck> {
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const e of entries) {
    if (e.seq !== expectedSeq || e.prev_hash !== prev) return { ok: false, count: entries.length, head: null, brokenAt: e.seq };
    const hash = await sha256Hex(canonical(e));
    if (hash !== e.hash) return { ok: false, count: entries.length, head: null, brokenAt: e.seq };
    prev = e.hash;
    expectedSeq += 1;
  }
  return { ok: true, count: entries.length, head: entries.length ? prev : null, brokenAt: null };
}
