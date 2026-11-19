// Per-visitor sandboxes for the public demo, and the single 'main' desk in production.

import { cookie, getCookie, HttpError, log, randomId, sha256Hex } from "./http";
import { isDemo } from "./identity";
import { seedStatements } from "./seed";

export const SANDBOX_COOKIE = "od_sbx";
export const PROD_DESK = "main";
const SANDBOX_ID = /^[A-Za-z0-9_-]{22}$/;
const DAY = 86_400_000;

export interface SandboxEnv {
  DB: D1Database;
  DEMO_MODE: string;
  SANDBOX_TTL_HOURS: string;
  MAX_NEW_SANDBOXES_PER_IP_PER_DAY: string;
  MAX_NEW_SANDBOXES_PER_DAY: string;
  DEMO_ROWS_PER_DAY: string;
  DEMO_ROWS_PER_IP_PER_DAY: string;
}

export interface Desk {
  id: string;
  createdAt: number;
  expiresAt: number | null;
  setCookie?: string;
  fresh?: boolean;
}

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

function intVar(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

export function ttlMs(env: SandboxEnv): number {
  return intVar(env.SANDBOX_TTL_HOURS, 24, 1, 168) * 3_600_000;
}

/** The caller's desk, or null when the demo visitor has no live sandbox. Never creates anything. */
export async function currentDesk(request: Request, env: SandboxEnv, now: number): Promise<Desk | null> {
  if (!isDemo(env)) return { id: PROD_DESK, createdAt: 0, expiresAt: null };
  const id = getCookie(request, SANDBOX_COOKIE);
  if (!id || !SANDBOX_ID.test(id)) return null;
  const row = await env.DB.prepare(`SELECT created_at FROM sandboxes WHERE id = ?1`).bind(id).first<{ created_at: number }>();
  if (!row) return null;
  const expiresAt = row.created_at + ttlMs(env);
  if (expiresAt <= now) return null;
  return { id, createdAt: row.created_at, expiresAt };
}

/** Returns the caller's desk, creating and seeding a fresh sandbox in demo mode when needed. */
export async function openDesk(request: Request, env: SandboxEnv, ctx: WaitUntil, now: number): Promise<Desk> {
  if (!isDemo(env)) {
    await env.DB.prepare(`INSERT OR IGNORE INTO sandboxes (id, created_at, template) VALUES (?1, ?2, 'production')`)
      .bind(PROD_DESK, now)
      .run();
    return { id: PROD_DESK, createdAt: 0, expiresAt: null };
  }
  const existing = await currentDesk(request, env, now);
  if (existing) return existing;
  return mintSandbox(request, env, ctx, now);
}

/** Deletes the caller's sandbox and starts a fresh one from the template. */
export async function resetDesk(request: Request, env: SandboxEnv, ctx: WaitUntil, now: number): Promise<Desk> {
  if (!isDemo(env)) throw new HttpError(404, "not_found", "Reset only exists in the demo.");
  const existing = await currentDesk(request, env, now);
  const fresh = await mintSandbox(request, env, ctx, now);
  if (existing) await chargeRows(request, env, now, await deleteSandboxes(env.DB, [existing.id]));
  return fresh;
}

async function mintSandbox(request: Request, env: SandboxEnv, ctx: WaitUntil, now: number): Promise<Desk> {
  await assertWriteBudget(request, env, now);
  await enforceMintCaps(request, env, now);
  const id = randomId(16); // 128 bits from crypto.getRandomValues
  const seeded = await env.DB.batch(await seedStatements(env.DB, id, now));
  const rowsWritten = seeded.reduce((sum, r) => sum + (r.meta?.rows_written ?? 0), 0);
  await chargeRows(request, env, now, rowsWritten);
  ctx.waitUntil(purgeExpired(env, now).catch((err) => log("error", "purge_failed", { message: String(err) })));
  const ttl = ttlMs(env);
  log("info", "sandbox_created", { rowsWritten });
  return {
    id,
    createdAt: now,
    expiresAt: now + ttl,
    fresh: true,
    setCookie: cookie(request, SANDBOX_COOKIE, id, Math.floor(ttl / 1000)),
  };
}

async function ipBucket(request: Request, prefix: string, day: number): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  return `${prefix}:${(await sha256Hex(`${day}|${ip}`)).slice(0, 32)}`;
}

function retryAfter(now: number): Record<string, string> {
  const day = Math.floor(now / DAY);
  return { "retry-after": String(Math.ceil(((day + 1) * DAY - now) / 1000)) };
}

async function readCounters(db: D1Database, buckets: string[]): Promise<Map<string, number>> {
  const marks = buckets.map((_, i) => `?${i + 1}`).join(", ");
  const { results } = await db
    .prepare(`SELECT bucket, n FROM mint_counters WHERE bucket IN (${marks})`)
    .bind(...buckets)
    .all<{ bucket: string; n: number }>();
  return new Map(results.map((r) => [r.bucket, r.n]));
}

function bumpStmt(db: D1Database, bucket: string, day: number, by: number): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO mint_counters (bucket, day, n) VALUES (?1, ?2, ?3) ON CONFLICT (bucket) DO UPDATE SET n = n + ?3`)
    .bind(bucket, day, by);
}

/**
 * Abuse guard: at most N new sandboxes per IP per UTC day, and M in total.
 * The counters are read first, so a refused attempt writes nothing.
 * The IP is stored only as a truncated SHA-256 of (day, IP) and the counter rows are purged the next day.
 */
async function enforceMintCaps(request: Request, env: SandboxEnv, now: number): Promise<void> {
  const day = Math.floor(now / DAY);
  const ipKey = await ipBucket(request, "ip", day);
  const allKey = `all:${day}`;
  const seen = await readCounters(env.DB, [ipKey, allKey]);
  if ((seen.get(ipKey) ?? 0) >= intVar(env.MAX_NEW_SANDBOXES_PER_IP_PER_DAY, 20, 1, 100_000)) {
    throw new HttpError(429, "sandbox_quota", "Too many new sandboxes from your network today. Try again after 00:00 UTC.", undefined, retryAfter(now));
  }
  if ((seen.get(allKey) ?? 0) >= intVar(env.MAX_NEW_SANDBOXES_PER_DAY, 100, 1, 1_000_000)) {
    throw new HttpError(429, "demo_busy", "The demo has reached today's limit of new sandboxes. Try again after 00:00 UTC.", undefined, retryAfter(now));
  }
  await env.DB.batch([bumpStmt(env.DB, ipKey, day, 1), bumpStmt(env.DB, allKey, day, 1)]);
}

/**
 * D1's free plan allows 100,000 written rows a day for the whole account, deletes and index rows included
 * (https://developers.cloudflare.com/d1/platform/pricing/). The demo keeps its own daily row budget so that
 * a script cannot spend the account's quota: once today's demo total, or this network's share of it, is used up,
 * every demo write is refused with 429 until 00:00 UTC. The purge is never refused, but its rows count too.
 */
export async function assertWriteBudget(request: Request, env: SandboxEnv, now: number): Promise<void> {
  if (!isDemo(env)) return;
  const day = Math.floor(now / DAY);
  const ipKey = await ipBucket(request, "rowsip", day);
  const allKey = `rows:${day}`;
  const seen = await readCounters(env.DB, [ipKey, allKey]);
  if ((seen.get(allKey) ?? 0) >= intVar(env.DEMO_ROWS_PER_DAY, 25_000, 1, 10_000_000)) {
    throw new HttpError(429, "demo_budget", "The public demo has used today's write budget. It opens again after 00:00 UTC.", undefined, retryAfter(now));
  }
  if ((seen.get(ipKey) ?? 0) >= intVar(env.DEMO_ROWS_PER_IP_PER_DAY, 4_000, 1, 10_000_000)) {
    throw new HttpError(429, "demo_budget_ip", "Your network has used its share of today's demo writes. Try again after 00:00 UTC.", undefined, retryAfter(now));
  }
}

/** Adds rows written (plus the counter rows themselves) to today's demo totals. `request` null = system work (purge). */
export async function chargeRows(request: Request | null, env: SandboxEnv, now: number, rows: number): Promise<void> {
  if (!isDemo(env) || rows <= 0) return;
  const day = Math.floor(now / DAY);
  const counterRows = request ? 2 : 1;
  const stmts = [bumpStmt(env.DB, `rows:${day}`, day, rows + counterRows)];
  if (request) stmts.push(bumpStmt(env.DB, await ipBucket(request, "rowsip", day), day, rows + counterRows));
  await env.DB.batch(stmts);
}

/** Opportunistic retention: removes up to `limit` sandboxes older than the TTL, plus old counters. */
export async function purgeExpired(env: SandboxEnv, now: number, limit = 25): Promise<number> {
  const cutoff = now - ttlMs(env);
  const { results } = await env.DB.prepare(
    `SELECT id FROM sandboxes WHERE created_at < ?1 AND id <> ?2 ORDER BY created_at LIMIT ?3`,
  )
    .bind(cutoff, PROD_DESK, limit)
    .all<{ id: string }>();
  const ids = results.map((r) => r.id);
  const rowsWritten = await deleteSandboxes(env.DB, ids, Math.floor(now / DAY));
  if (ids.length) {
    log("info", "sandboxes_purged", { count: ids.length, rowsWritten });
    await chargeRows(null, env, now, rowsWritten);
  }
  return ids.length;
}

/** The sandbox row goes first: the audit-log delete trigger only allows rows whose sandbox is gone. Returns rows written. */
async function deleteSandboxes(db: D1Database, ids: string[], today?: number): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  if (ids.length) {
    const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
    for (const sql of [
      `DELETE FROM sandboxes WHERE id IN (${marks})`,
      `DELETE FROM requests WHERE sandbox_id IN (${marks})`,
      `DELETE FROM checklist_items WHERE sandbox_id IN (${marks})`,
      `DELETE FROM alerts WHERE sandbox_id IN (${marks})`,
      `DELETE FROM audit_log WHERE sandbox_id IN (${marks})`,
    ]) {
      stmts.push(db.prepare(sql).bind(...ids));
    }
  }
  if (today !== undefined) stmts.push(db.prepare(`DELETE FROM mint_counters WHERE day < ?1`).bind(today));
  if (!stmts.length) return 0;
  const results = await db.batch(stmts);
  return results.reduce((sum, r) => sum + (r.meta?.rows_written ?? 0), 0);
}

/** Roughly one request in `every` also runs the purge in the background. */
export function maybePurge(env: SandboxEnv, ctx: WaitUntil, now: number, every = 25): void {
  if (!isDemo(env)) return;
  const roll = new Uint8Array(1);
  crypto.getRandomValues(roll);
  if (roll[0] % every !== 0) return;
  ctx.waitUntil(purgeExpired(env, now).catch((err) => log("error", "purge_failed", { message: String(err) })));
}
