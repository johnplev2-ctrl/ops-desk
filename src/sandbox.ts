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
  if (existing) await deleteSandboxes(env.DB, [existing.id]);
  return fresh;
}

async function mintSandbox(request: Request, env: SandboxEnv, ctx: WaitUntil, now: number): Promise<Desk> {
  await enforceMintCaps(request, env, now);
  const id = randomId(16); // 128 bits from crypto.getRandomValues
  const seeded = await env.DB.batch(await seedStatements(env.DB, id, now));
  const rowsWritten = seeded.reduce((sum, r) => sum + (r.meta?.rows_written ?? 0), 0);
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

/**
 * Abuse guard: at most N new sandboxes per IP per UTC day, and M in total.
 * The IP is stored only as a truncated SHA-256 of (day, IP) and the counter rows are purged the next day.
 */
async function enforceMintCaps(request: Request, env: SandboxEnv, now: number): Promise<void> {
  const day = Math.floor(now / DAY);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const ipBucket = `ip:${(await sha256Hex(`${day}|${ip}`)).slice(0, 32)}`;
  const allBucket = `all:${day}`;
  const bump = (bucket: string) =>
    env.DB.prepare(
      `INSERT INTO mint_counters (bucket, day, n) VALUES (?1, ?2, 1)
       ON CONFLICT (bucket) DO UPDATE SET n = n + 1 RETURNING n`,
    ).bind(bucket, day);
  const [ipRes, allRes] = await env.DB.batch<{ n: number }>([bump(ipBucket), bump(allBucket)]);
  const ipCount = ipRes.results[0]?.n ?? 0;
  const allCount = allRes.results[0]?.n ?? 0;
  const retryAfter = String(Math.ceil(((day + 1) * DAY - now) / 1000));
  if (ipCount > intVar(env.MAX_NEW_SANDBOXES_PER_IP_PER_DAY, 20, 1, 100_000)) {
    throw new HttpError(429, "sandbox_quota", "Too many new sandboxes from your network today. Try again after 00:00 UTC.", undefined, { "retry-after": retryAfter });
  }
  if (allCount > intVar(env.MAX_NEW_SANDBOXES_PER_DAY, 300, 1, 1_000_000)) {
    throw new HttpError(429, "demo_busy", "The demo has reached today's limit of new sandboxes. Try again after 00:00 UTC.", undefined, { "retry-after": retryAfter });
  }
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
  await deleteSandboxes(env.DB, ids, Math.floor(now / DAY));
  if (ids.length) log("info", "sandboxes_purged", { count: ids.length });
  return ids.length;
}

/** The sandbox row goes first: the audit-log delete trigger only allows rows whose sandbox is gone. */
async function deleteSandboxes(db: D1Database, ids: string[], today?: number): Promise<void> {
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
  if (stmts.length) await db.batch(stmts);
}

/** Roughly one request in `every` also runs the purge in the background. */
export function maybePurge(env: SandboxEnv, ctx: WaitUntil, now: number, every = 25): void {
  if (!isDemo(env)) return;
  const roll = new Uint8Array(1);
  crypto.getRandomValues(roll);
  if (roll[0] % every !== 0) return;
  ctx.waitUntil(purgeExpired(env, now).catch((err) => log("error", "purge_failed", { message: String(err) })));
}
