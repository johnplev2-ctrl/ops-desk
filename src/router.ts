// The whole API. Mounted by functions/api/[[path]].ts, so static files never invoke a Function.

import { adapterName, deliverAlerts, type NewAlert, type OutboundEnv } from "./alerts";
import * as desk from "./desk";
import { cookie, errorResponse, HttpError, json, log, readJson, sha256Hex, textFile } from "./http";
import { DEMO_PERSONAS, isDemo, resolveIdentity, ROLE_COOKIE, ROLES, type Identity, type IdentityEnv, type Role } from "./identity";
import { currentDesk, maybePurge, openDesk, resetDesk, ttlMs, type Desk, type SandboxEnv } from "./sandbox";
import { PHOTO_CAPTIONS, WORKSPACE_NAME } from "./seed";
import { LIMITS, tzOffset } from "./validate";

export type AppEnv = SandboxEnv & IdentityEnv & OutboundEnv & { DB: D1Database };

export interface AppContext {
  request: Request;
  env: AppEnv;
  waitUntil(promise: Promise<unknown>): void;
}

type Handler = (r: Route) => Promise<Response>;

interface Route {
  ctx: AppContext;
  request: Request;
  env: AppEnv;
  url: URL;
  params: string[];
  now: number;
}

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
function on(method: string, path: string, handler: Handler) {
  const pattern = new RegExp(`^${path.replace(/:\w+/g, "([^/]+)")}$`);
  routes.push({ method, pattern, handler });
}

export async function handle(ctx: AppContext): Promise<Response> {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "").replace(/\/+$/, "") || "/";
  const now = Date.now();
  try {
    const matches = routes.filter((r) => r.pattern.test(path));
    if (matches.length === 0) throw new HttpError(404, "not_found", "No such endpoint.");
    const route = matches.find((r) => r.method === request.method);
    if (!route) {
      const allow = [...new Set(matches.map((r) => r.method))].join(", ");
      throw new HttpError(405, "method_not_allowed", `Use ${allow} for this endpoint.`, undefined, { allow });
    }
    if (request.method !== "GET") assertSameOrigin(request, url);
    if (path !== "/health") maybePurge(env, ctx, now);
    const params = route.pattern.exec(path)!.slice(1).map(decodeURIComponent);
    return await route.handler({ ctx, request, env, url, params, now });
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    log("error", "unhandled", { path, message: err instanceof Error ? err.message : String(err) });
    return errorResponse(new HttpError(500, "server_error", "Something failed on the server. Try again."));
  }
}

/** Defence in depth on top of SameSite=Lax cookies: writes must come from this origin. */
function assertSameOrigin(request: Request, url: URL): void {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new HttpError(403, "cross_site", "Cross-site requests are not allowed.");
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "cross_site", "Cross-site requests are not allowed.");
}

async function deskOrFail(r: Route): Promise<Desk> {
  const d = await currentDesk(r.request, r.env, r.now);
  if (!d) throw new HttpError(401, "no_sandbox", "Your demo sandbox expired or was reset. Reload to get a fresh one.");
  return d;
}

async function context(r: Route): Promise<{ c: desk.Ctx; who: Identity; d: Desk }> {
  const who = await resolveIdentity(r.request, r.env);
  const d = await deskOrFail(r);
  return {
    who,
    d,
    c: { db: r.env.DB, sandboxId: d.id, who, demo: isDemo(r.env), now: r.now, delivery: adapterName(r.env) },
  };
}

function afterWrite(r: Route, sandboxId: string, alerts: Array<{ id: number; alert: NewAlert }>): void {
  if (alerts.length && adapterName(r.env) !== "stub") {
    r.ctx.waitUntil(
      deliverAlerts(r.env, sandboxId, alerts).catch((err) => log("error", "alert_delivery_crashed", { message: String(err) })),
    );
  }
}

async function sessionBody(r: Route, who: Identity, d: Desk) {
  const c: desk.Ctx = { db: r.env.DB, sandboxId: d.id, who, demo: isDemo(r.env), now: r.now, delivery: adapterName(r.env) };
  const unread = (await desk.unreadQuery(c).first<{ n: number }>())?.n ?? 0;
  return {
    mode: isDemo(r.env) ? "demo" : "production",
    role: who.role,
    actor: who.actor,
    identitySource: who.source,
    workspace: isDemo(r.env) ? WORKSPACE_NAME : "Ops desk",
    personas: isDemo(r.env) ? DEMO_PERSONAS : null,
    sandbox: isDemo(r.env)
      ? { tag: (await sha256Hex(d.id)).slice(0, 6), createdAt: d.createdAt, expiresAt: d.expiresAt, fresh: Boolean(d.fresh), ttlHours: ttlMs(r.env) / 3_600_000 }
      : null,
    limits: LIMITS,
    photos: PHOTO_CAPTIONS,
    outbound: { adapter: adapterName(r.env) },
    unread,
  };
}

// ---------- routes ----------

on("GET", "/health", async () => json({ ok: true }));

on("GET", "/session", async (r) => {
  const who = await resolveIdentity(r.request, r.env);
  const d = await openDesk(r.request, r.env, r.ctx, r.now);
  const headers = new Headers();
  if (d.setCookie) headers.append("set-cookie", d.setCookie);
  return json(await sessionBody(r, who, d), 200, headers);
});

on("POST", "/role", async (r) => {
  if (!isDemo(r.env)) throw new HttpError(404, "not_found", "Roles come from Cloudflare Access in production.");
  const body = await readJson(r.request, LIMITS.bodyBytes);
  const role = body.role;
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) {
    throw new HttpError(400, "invalid_input", "role must be owner, manager or staff.", "role");
  }
  const d = await deskOrFail(r);
  const who: Identity = { role: role as Role, actor: DEMO_PERSONAS[role as Role], source: "demo" };
  const headers = new Headers();
  headers.append("set-cookie", cookie(r.request, ROLE_COOKIE, role, Math.floor(ttlMs(r.env) / 1000)));
  return json(await sessionBody(r, who, d), 200, headers);
});

on("POST", "/sandbox/reset", async (r) => {
  await readJson(r.request, LIMITS.bodyBytes);
  const who = await resolveIdentity(r.request, r.env);
  const d = await resetDesk(r.request, r.env, r.ctx, r.now);
  const headers = new Headers();
  if (d.setCookie) headers.append("set-cookie", d.setCookie);
  return json(await sessionBody(r, who, d), 200, headers);
});

on("GET", "/requests", async (r) => {
  const { c } = await context(r);
  return json({ requests: await desk.listRequests(c), now: r.now });
});

on("POST", "/requests", async (r) => {
  const { c, d } = await context(r);
  const body = await readJson(r.request, LIMITS.bodyBytes);
  const result = await desk.createRequest(c, body, tzOffset(body.tz));
  afterWrite(r, d.id, result.alerts);
  return json({ ref: result.ref }, 201);
});

on("GET", "/requests/:ref", async (r) => {
  const { c } = await context(r);
  return json({ ...(await desk.getRequest(c, desk.parseRef(r.params[0]))), now: r.now });
});

on("POST", "/requests/:ref/decision", async (r) => {
  const { c, d } = await context(r);
  const ref = desk.parseRef(r.params[0]);
  const result = await desk.decide(c, ref, await readJson(r.request, LIMITS.bodyBytes));
  afterWrite(r, d.id, result.alerts);
  return json({ ok: true });
});

on("POST", "/requests/:ref/checklist/:pos", async (r) => {
  const { c } = await context(r);
  const ref = desk.parseRef(r.params[0]);
  const pos = Number(r.params[1]);
  if (!Number.isInteger(pos) || pos < 1 || pos > LIMITS.checklistItems) throw new HttpError(404, "not_found", "No such checklist item.");
  await desk.tick(c, ref, pos, await readJson(r.request, LIMITS.bodyBytes));
  return json({ ok: true });
});

on("POST", "/requests/:ref/complete", async (r) => {
  const { c, d } = await context(r);
  const ref = desk.parseRef(r.params[0]);
  const result = await desk.complete(c, ref, await readJson(r.request, LIMITS.bodyBytes));
  afterWrite(r, d.id, result.alerts);
  return json({ ok: true });
});

on("GET", "/dashboard", async (r) => {
  const { c } = await context(r);
  return json({ ...(await desk.dashboard(c, tzOffset(r.url.searchParams.get("tz")))), now: r.now });
});

on("GET", "/audit", async (r) => {
  const { c } = await context(r);
  const before = r.url.searchParams.get("before");
  const limit = Number(r.url.searchParams.get("limit") ?? 50);
  return json(await desk.listAudit(c, before ? Number(before) || null : null, Number.isFinite(limit) ? limit : 50));
});

on("GET", "/audit/verify", async (r) => {
  const { c } = await context(r);
  return json(await desk.verifyAudit(c));
});

on("GET", "/export/requests.csv", async (r) => {
  const { c } = await context(r);
  const day = new Date(r.now).toISOString().slice(0, 10);
  return textFile(await desk.exportRequestsCsv(c), `ops-desk-requests-${day}.csv`, "text/csv; charset=utf-8");
});

on("GET", "/export/audit.csv", async (r) => {
  const { c } = await context(r);
  const day = new Date(r.now).toISOString().slice(0, 10);
  return textFile(await desk.exportAuditCsv(c), `ops-desk-audit-${day}.csv`, "text/csv; charset=utf-8");
});

on("GET", "/alerts", async (r) => {
  const { c } = await context(r);
  return json({ ...(await desk.listAlerts(c)), outbound: { adapter: adapterName(r.env) } });
});

on("POST", "/alerts/read", async (r) => {
  const { c } = await context(r);
  await readJson(r.request, LIMITS.bodyBytes);
  await desk.markAlertsRead(c);
  return json({ ok: true });
});
