// Requests, approvals, checklists, completion, dashboard, audit and alert reads.
// Every write is one D1 batch (a transaction) that also appends to the audit chain.
// The audit head read before the write acts as an optimistic lock: if another write lands
// in between, the chain insert fails, the whole batch rolls back and the caller gets 409.

import { buildAlerts, insertAlerts, type AlertEvent, type NewAlert } from "./alerts";
import { extendChain, headQuery, insertAudit, verifyChain, type AuditEntry, type AuditFields, type ChainHead } from "./audit";
import { iso, toCsv } from "./csv";
import { HttpError, log } from "./http";
import type { Identity, Role } from "./identity";
import { PHOTO_CAPTIONS } from "./seed";
import * as v from "./validate";

export interface RequestRow {
  ref: number;
  kind: v.Kind;
  title: string;
  details: string;
  location: string;
  cost_cents: number | null;
  due_at: number;
  status: "pending" | "approved" | "rejected" | "done";
  created_at: number;
  created_by: string;
  decided_at: number | null;
  decided_by: string | null;
  decision_note: string | null;
  completed_at: number | null;
  completed_by: string | null;
  proof_photo: v.Photo | null;
  items_total?: number;
  items_done?: number;
}

interface ChecklistRow {
  pos: number;
  label: string;
  done_at: number | null;
  done_by: string | null;
}

export interface Ctx {
  db: D1Database;
  sandboxId: string;
  who: Identity;
  demo: boolean;
  now: number;
  delivery: string; // adapter name recorded on new alerts
}

export interface WriteResult {
  alerts: Array<{ id: number; alert: NewAlert }>;
  rowsWritten: number;
}

const STATUS_WORD: Record<RequestRow["status"], string> = {
  pending: "awaiting approval",
  approved: "approved",
  rejected: "rejected",
  done: "done",
};

export function allow(who: Identity, roles: Role[], message: string): void {
  if (!roles.includes(who.role)) throw new HttpError(403, "forbidden", message);
}

function isOverdue(r: Pick<RequestRow, "status" | "due_at">, now: number): boolean {
  return (r.status === "pending" || r.status === "approved") && r.due_at < now;
}

export function present(r: RequestRow, now: number) {
  return {
    ref: r.ref,
    kind: r.kind,
    title: r.title,
    details: r.details,
    location: r.location,
    costCents: r.cost_cents,
    dueAt: r.due_at,
    status: r.status,
    overdue: isOverdue(r, now),
    createdAt: r.created_at,
    createdBy: r.created_by,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    completedAt: r.completed_at,
    completedBy: r.completed_by,
    proofPhoto: r.proof_photo,
    checklistTotal: r.items_total ?? 0,
    checklistDone: r.items_done ?? 0,
  };
}

const REQUEST_COLUMNS = `r.ref, r.kind, r.title, r.details, r.location, r.cost_cents, r.due_at, r.status, r.created_at, r.created_by,
  r.decided_at, r.decided_by, r.decision_note, r.completed_at, r.completed_by, r.proof_photo,
  (SELECT COUNT(*) FROM checklist_items c WHERE c.sandbox_id = r.sandbox_id AND c.ref = r.ref) AS items_total,
  (SELECT COUNT(*) FROM checklist_items c WHERE c.sandbox_id = r.sandbox_id AND c.ref = r.ref AND c.done_at IS NOT NULL) AS items_done`;

function requestQuery(c: Ctx, ref: number): D1PreparedStatement {
  return c.db.prepare(`SELECT ${REQUEST_COLUMNS} FROM requests r WHERE r.sandbox_id = ?1 AND r.ref = ?2`).bind(c.sandboxId, ref);
}

function checklistQuery(c: Ctx, ref: number): D1PreparedStatement {
  return c.db
    .prepare(`SELECT pos, label, done_at, done_by FROM checklist_items WHERE sandbox_id = ?1 AND ref = ?2 ORDER BY pos`)
    .bind(c.sandboxId, ref);
}

export function parseRef(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new HttpError(404, "not_found", "No such request.");
  return n;
}

function notFound(ref: number): HttpError {
  return new HttpError(404, "not_found", `R-${ref} does not exist on this desk.`);
}

/** Appends audit entries + alerts to the given statements and runs everything as one transaction. */
async function commit(
  c: Ctx,
  head: ChainHead | null,
  statements: D1PreparedStatement[],
  events: AuditFields[],
  alerts: NewAlert[],
): Promise<WriteResult> {
  if (c.demo && (head?.seq ?? 0) + events.length > v.LIMITS.auditPerSandbox) {
    throw new HttpError(409, "sandbox_full", "This sandbox has reached its demo limit. Reset it to start over.");
  }
  const entries = await extendChain(head, events);
  const alertStmts = insertAlerts(c.db, c.sandboxId, alerts, c.delivery);
  const all = [...statements, ...insertAudit(c.db, c.sandboxId, entries), ...alertStmts];
  // Keep the demo alert feed bounded; checked every 50 audit entries to save reads.
  const trim = c.demo && Math.floor(((head?.seq ?? 0) + entries.length) / 50) > Math.floor((head?.seq ?? 0) / 50);
  if (trim) {
    all.push(
      c.db
        .prepare(
          `DELETE FROM alerts WHERE sandbox_id = ?1 AND id NOT IN
             (SELECT id FROM alerts WHERE sandbox_id = ?1 ORDER BY id DESC LIMIT ?2)`,
        )
        .bind(c.sandboxId, v.LIMITS.alertsPerSandbox),
    );
  }
  let results: D1Result[];
  try {
    results = await c.db.batch(all);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/append-only|UNIQUE constraint failed/i.test(message)) {
      throw new HttpError(409, "conflict", "Someone else changed this desk at the same moment. Reload and try again.");
    }
    throw err;
  }
  const rowsWritten = results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0);
  log("info", "write", { action: events[0]?.action, rowsWritten });
  const alertResults = results.slice(statements.length + entries.length, statements.length + entries.length + alertStmts.length);
  return {
    alerts: alertResults.map((r, i) => ({ id: (r.results[0] as { id: number }).id, alert: alerts[i] })),
    rowsWritten,
  };
}

function audit(c: Ctx, action: string, ref: number | null, detail: string): AuditFields {
  return { at: c.now, actor: c.who.actor, role: c.who.role, action, ref, detail };
}

function alertsFor(c: Ctx, event: AlertEvent, ref: number, title: string): NewAlert[] {
  return buildAlerts(event, ref, title, c.who.actor, c.now);
}

// ---------- reads ----------

export async function listRequests(c: Ctx) {
  const { results } = await c.db
    .prepare(
      `SELECT ${REQUEST_COLUMNS} FROM requests r WHERE r.sandbox_id = ?1
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
                CASE WHEN r.status IN ('pending', 'approved') THEN r.due_at ELSE -COALESCE(r.completed_at, r.decided_at, r.created_at) END
       LIMIT 200`,
    )
    .bind(c.sandboxId)
    .all<RequestRow>();
  return results.map((r) => present(r, c.now));
}

export async function getRequest(c: Ctx, ref: number) {
  const [req, items, trail] = await c.db.batch([
    requestQuery(c, ref),
    checklistQuery(c, ref),
    c.db
      .prepare(
        `SELECT seq, at, actor, role, action, detail FROM audit_log WHERE sandbox_id = ?1 AND ref = ?2 ORDER BY seq`,
      )
      .bind(c.sandboxId, ref),
  ]);
  const row = req.results[0] as RequestRow | undefined;
  if (!row) throw notFound(ref);
  return {
    request: present(row, c.now),
    checklist: (items.results as ChecklistRow[]).map((i) => ({ pos: i.pos, label: i.label, doneAt: i.done_at, doneBy: i.done_by })),
    trail: trail.results,
  };
}

// ---------- writes ----------

export async function createRequest(c: Ctx, body: Record<string, unknown>, tz: number): Promise<{ ref: number } & WriteResult> {
  allow(c.who, ["staff", "manager"], "Only staff and managers file requests.");
  const kind = v.oneOf(body, "kind", v.KINDS);
  const title = v.text(body, "title", { min: 1, max: v.LIMITS.title });
  const details = v.text(body, "details", { max: v.LIMITS.details, multiline: true });
  const location = v.text(body, "location", { max: v.LIMITS.location });
  const cost = kind === "task" ? null : v.costCents(body);
  const due = v.dueAt(body, tz, c.now);
  const items = v.checklist(body);

  const [headRes, countRes] = await c.db.batch([
    headQuery(c.db, c.sandboxId),
    c.db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(ref), 100) AS max_ref FROM requests WHERE sandbox_id = ?1`)
      .bind(c.sandboxId),
  ]);
  const head = (headRes.results[0] as ChainHead | undefined) ?? null;
  const { n, max_ref } = countRes.results[0] as { n: number; max_ref: number };
  if (c.demo && n >= v.LIMITS.requestsPerSandbox) {
    throw new HttpError(409, "sandbox_full", `A demo sandbox holds at most ${v.LIMITS.requestsPerSandbox} requests. Reset it to start over.`);
  }
  const ref = max_ref + 1;

  const values = items.map((_, i) => `(?1, ?2, ?${i * 2 + 3}, ?${i * 2 + 4})`).join(", ");
  const stmts = [
    c.db
      .prepare(
        `INSERT INTO requests (sandbox_id, ref, kind, title, details, location, cost_cents, due_at, status, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10)`,
      )
      .bind(c.sandboxId, ref, kind, title, details, location, cost, due, c.now, c.who.actor),
    c.db
      .prepare(`INSERT INTO checklist_items (sandbox_id, ref, pos, label) VALUES ${values}`)
      .bind(c.sandboxId, ref, ...items.flatMap((label, i) => [i + 1, label])),
  ];
  const result = await commit(
    c,
    head,
    stmts,
    [audit(c, "request.created", ref, `Filed ${kind} request "${title}" with ${items.length} checklist ${items.length === 1 ? "item" : "items"}`)],
    alertsFor(c, "created", ref, title),
  );
  return { ref, ...result };
}

export async function decide(c: Ctx, ref: number, body: Record<string, unknown>): Promise<WriteResult> {
  allow(c.who, ["manager", "owner"], "Only managers and owners approve or reject requests.");
  const decision = v.oneOf(body, "decision", ["approve", "reject"] as const);
  const note = v.text(body, "note", { max: v.LIMITS.note, min: decision === "reject" ? 3 : 0, multiline: true });

  const [headRes, reqRes] = await c.db.batch([headQuery(c.db, c.sandboxId), requestQuery(c, ref)]);
  const row = reqRes.results[0] as RequestRow | undefined;
  if (!row) throw notFound(ref);
  if (row.status !== "pending") {
    throw new HttpError(409, "wrong_status", `R-${ref} is already ${STATUS_WORD[row.status]}.`);
  }
  const approved = decision === "approve";
  const stmt = c.db
    .prepare(
      `UPDATE requests SET status = ?3, decided_at = ?4, decided_by = ?5, decision_note = ?6
       WHERE sandbox_id = ?1 AND ref = ?2 AND status = 'pending'`,
    )
    .bind(c.sandboxId, ref, approved ? "approved" : "rejected", c.now, c.who.actor, note);
  const word = approved ? "Approved" : "Rejected";
  return commit(
    c,
    (headRes.results[0] as ChainHead | undefined) ?? null,
    [stmt],
    [audit(c, approved ? "request.approved" : "request.rejected", ref, note ? `${word} with note "${note}"` : word)],
    alertsFor(c, approved ? "approved" : "rejected", ref, row.title),
  );
}

export async function tick(c: Ctx, ref: number, pos: number, body: Record<string, unknown>): Promise<WriteResult> {
  allow(c.who, ["staff"], "Only staff tick checklist items.");
  if (typeof body.done !== "boolean") throw v.invalid("done", "done must be true or false.");
  const done = body.done;
  const [headRes, reqRes, itemsRes] = await c.db.batch([headQuery(c.db, c.sandboxId), requestQuery(c, ref), checklistQuery(c, ref)]);
  const row = reqRes.results[0] as RequestRow | undefined;
  if (!row) throw notFound(ref);
  const item = (itemsRes.results as ChecklistRow[]).find((i) => i.pos === pos);
  if (!item) throw new HttpError(404, "not_found", `R-${ref} has no checklist item ${pos}.`);
  if (row.status !== "approved") {
    throw new HttpError(409, "wrong_status", `The checklist opens once R-${ref} is approved. It is ${STATUS_WORD[row.status]}.`);
  }
  if ((item.done_at !== null) === done) return { alerts: [], rowsWritten: 0 }; // already in that state; nothing to record
  const stmt = c.db
    .prepare(`UPDATE checklist_items SET done_at = ?4, done_by = ?5 WHERE sandbox_id = ?1 AND ref = ?2 AND pos = ?3`)
    .bind(c.sandboxId, ref, pos, done ? c.now : null, done ? c.who.actor : null);
  return commit(
    c,
    (headRes.results[0] as ChainHead | undefined) ?? null,
    [stmt],
    [audit(c, done ? "checklist.ticked" : "checklist.unticked", ref, `${done ? "Ticked" : "Unticked"} "${item.label}"`)],
    [],
  );
}

export async function complete(c: Ctx, ref: number, body: Record<string, unknown>): Promise<WriteResult> {
  allow(c.who, ["staff"], "Only staff mark requests as done.");
  const photo = body.photo;
  if (typeof photo !== "string" || !(v.PHOTOS as readonly string[]).includes(photo)) {
    throw v.invalid("photo", "Pick one of the six sample photos as proof. Uploads are switched off in the demo.");
  }
  const [headRes, reqRes] = await c.db.batch([headQuery(c.db, c.sandboxId), requestQuery(c, ref)]);
  const row = reqRes.results[0] as RequestRow | undefined;
  if (!row) throw notFound(ref);
  if (row.status !== "approved") {
    throw new HttpError(409, "wrong_status", `Only approved requests can be marked done. R-${ref} is ${STATUS_WORD[row.status]}.`);
  }
  const total = row.items_total ?? 0;
  const doneCount = row.items_done ?? 0;
  if (doneCount < total) {
    throw new HttpError(409, "checklist_incomplete", `Tick every checklist item first (${doneCount} of ${total} done).`);
  }
  const stmt = c.db
    .prepare(
      `UPDATE requests SET status = 'done', completed_at = ?3, completed_by = ?4, proof_photo = ?5
       WHERE sandbox_id = ?1 AND ref = ?2 AND status = 'approved'`,
    )
    .bind(c.sandboxId, ref, c.now, c.who.actor, photo);
  return commit(
    c,
    (headRes.results[0] as ChainHead | undefined) ?? null,
    [stmt],
    [audit(c, "request.completed", ref, `Marked done with proof photo ${photo} (${PHOTO_CAPTIONS[photo as v.Photo]})`)],
    alertsFor(c, "done", ref, row.title),
  );
}

// ---------- owner / manager views ----------

/** Monday 00:00 in the caller's time zone, as epoch ms. */
export function weekStart(now: number, tz: number): number {
  const local = new Date(now - tz * 60_000);
  const dow = (local.getUTCDay() + 6) % 7;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow) + tz * 60_000;
}

export async function dashboard(c: Ctx, tz: number) {
  allow(c.who, ["owner", "manager"], "The dashboard is for owners and managers.");
  const since = weekStart(c.now, tz);
  const [counts, overdue, byKind, decisions, recent] = await c.db.batch([
    c.db
      .prepare(
        `SELECT
           COALESCE(SUM(status = 'pending'), 0) AS awaiting,
           COALESCE(SUM(status = 'approved'), 0) AS open,
           COALESCE(SUM(status = 'done' AND completed_at >= ?2), 0) AS done_week,
           COALESCE(SUM(status IN ('pending', 'approved') AND due_at < ?3), 0) AS overdue,
           COALESCE(SUM(status = 'rejected'), 0) AS rejected,
           COUNT(*) AS total
         FROM requests WHERE sandbox_id = ?1`,
      )
      .bind(c.sandboxId, since, c.now),
    c.db
      .prepare(
        `SELECT ref, kind, title, status, due_at FROM requests
         WHERE sandbox_id = ?1 AND status IN ('pending', 'approved') AND due_at < ?2 ORDER BY due_at LIMIT 20`,
      )
      .bind(c.sandboxId, c.now),
    c.db
      .prepare(
        `SELECT kind, COUNT(*) AS n FROM requests WHERE sandbox_id = ?1 AND status IN ('pending', 'approved') GROUP BY kind`,
      )
      .bind(c.sandboxId),
    c.db
      .prepare(
        `SELECT decided_at - created_at AS ms FROM requests WHERE sandbox_id = ?1 AND decided_at IS NOT NULL
         ORDER BY decided_at DESC LIMIT 50`,
      )
      .bind(c.sandboxId),
    c.db
      .prepare(`SELECT seq, at, actor, role, action, ref, detail FROM audit_log WHERE sandbox_id = ?1 ORDER BY seq DESC LIMIT 8`)
      .bind(c.sandboxId),
  ]);
  const durations = (decisions.results as Array<{ ms: number }>).map((d) => d.ms).sort((a, b) => a - b);
  const median =
    durations.length === 0
      ? null
      : durations.length % 2
        ? durations[(durations.length - 1) / 2]
        : (durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2;
  const kinds: Record<string, number> = { repair: 0, purchase: 0, task: 0 };
  for (const k of byKind.results as Array<{ kind: string; n: number }>) kinds[k.kind] = k.n;
  const c0 = counts.results[0] as Record<string, number>;
  return {
    weekStart: since,
    counts: {
      awaitingApproval: c0.awaiting,
      open: c0.open,
      doneThisWeek: c0.done_week,
      overdue: c0.overdue,
      rejected: c0.rejected,
      total: c0.total,
    },
    overdue: (overdue.results as Array<{ ref: number; kind: string; title: string; status: string; due_at: number }>).map((r) => ({
      ref: r.ref,
      kind: r.kind,
      title: r.title,
      status: r.status,
      dueAt: r.due_at,
    })),
    openByKind: kinds,
    medianDecisionMs: median,
    recent: recent.results,
  };
}

const AUDIT_COLUMNS = `seq, at, actor, role, action, ref, detail, prev_hash, hash`;

export async function listAudit(c: Ctx, before: number | null, limit: number) {
  allow(c.who, ["owner", "manager"], "The audit log is for owners and managers.");
  const lim = Math.min(Math.max(limit, 1), 100);
  const { results } = await c.db
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE sandbox_id = ?1 AND seq < ?2 ORDER BY seq DESC LIMIT ?3`)
    .bind(c.sandboxId, before ?? Number.MAX_SAFE_INTEGER, lim)
    .all<AuditEntry>();
  return { entries: results, nextBefore: results.length === lim ? results[results.length - 1].seq : null };
}

async function allAudit(c: Ctx): Promise<AuditEntry[]> {
  const { results } = await c.db
    .prepare(`SELECT ${AUDIT_COLUMNS} FROM audit_log WHERE sandbox_id = ?1 ORDER BY seq ASC LIMIT 5000`)
    .bind(c.sandboxId)
    .all<AuditEntry>();
  return results;
}

export async function verifyAudit(c: Ctx) {
  allow(c.who, ["owner", "manager"], "The audit log is for owners and managers.");
  return verifyChain(await allAudit(c));
}

export async function exportRequestsCsv(c: Ctx): Promise<string> {
  allow(c.who, ["owner"], "Only the owner exports data.");
  const { results } = await c.db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM requests r WHERE r.sandbox_id = ?1 ORDER BY r.ref`)
    .bind(c.sandboxId)
    .all<RequestRow>();
  const header = [
    "ref", "kind", "title", "details", "location", "cost_eur", "status", "overdue", "due_at",
    "created_at", "created_by", "decided_at", "decided_by", "decision_note",
    "completed_at", "completed_by", "proof_photo", "checklist_done", "checklist_total",
  ];
  const rows = results.map((r) => [
    `R-${r.ref}`, r.kind, r.title, r.details, r.location, r.cost_cents === null ? "" : (r.cost_cents / 100).toFixed(2),
    r.status, isOverdue(r, c.now) ? "yes" : "no", iso(r.due_at),
    iso(r.created_at), r.created_by, iso(r.decided_at), r.decided_by, r.decision_note,
    iso(r.completed_at), r.completed_by, r.proof_photo, r.items_done ?? 0, r.items_total ?? 0,
  ]);
  return toCsv(header, rows);
}

export async function exportAuditCsv(c: Ctx): Promise<string> {
  allow(c.who, ["owner"], "Only the owner exports data.");
  const entries = await allAudit(c);
  return toCsv(
    ["seq", "at", "at_iso", "actor", "role", "action", "ref", "detail", "prev_hash", "hash"],
    entries.map((e) => [e.seq, e.at, iso(e.at), e.actor, e.role, e.action, e.ref, e.detail, e.prev_hash, e.hash]),
  );
}

// ---------- alerts ----------

export async function listAlerts(c: Ctx) {
  const [items, unread] = await c.db.batch([
    c.db
      .prepare(
        `SELECT id, at, ref, text, read_at, delivery, payload FROM alerts
         WHERE sandbox_id = ?1 AND audience = ?2 ORDER BY id DESC LIMIT 40`,
      )
      .bind(c.sandboxId, c.who.role),
    unreadQuery(c),
  ]);
  return {
    items: (items.results as Array<{ id: number; at: number; ref: number | null; text: string; read_at: number | null; delivery: string; payload: string }>).map((a) => ({
      id: a.id,
      at: a.at,
      ref: a.ref,
      text: a.text,
      read: a.read_at !== null,
      delivery: a.delivery,
      payload: a.payload,
    })),
    unread: (unread.results[0] as { n: number }).n,
  };
}

export function unreadQuery(c: Ctx): D1PreparedStatement {
  return c.db
    .prepare(`SELECT COUNT(*) AS n FROM alerts WHERE sandbox_id = ?1 AND audience = ?2 AND read_at IS NULL`)
    .bind(c.sandboxId, c.who.role);
}

export async function markAlertsRead(c: Ctx): Promise<number> {
  const res = await c.db
    .prepare(`UPDATE alerts SET read_at = ?3 WHERE sandbox_id = ?1 AND audience = ?2 AND read_at IS NULL`)
    .bind(c.sandboxId, c.who.role, c.now)
    .run();
  return res.meta?.rows_written ?? 0;
}
