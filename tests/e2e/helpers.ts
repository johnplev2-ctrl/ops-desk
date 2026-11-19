import { test as base, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export { expect };

// Each test (and each extra context) gets its own client IP so the per-IP sandbox cap
// from wrangler.jsonc applies exactly as configured. Local `wrangler pages dev` passes the header through.
let counter = 0;
export function uniqueIp(): string {
  counter += 1;
  return `10.${(process.pid % 200) + 1}.${Math.floor(counter / 250) % 250}.${(counter % 250) + 1}`;
}

export const test = base.extend({
  extraHTTPHeaders: async ({}, use) => {
    await use({ "cf-connecting-ip": uniqueIp() });
  },
});

export type Role = "staff" | "manager" | "owner";

export async function openDesk(page: Page, hash = "#/requests"): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
}

export async function asRole(page: Page, role: Role): Promise<void> {
  const radio = page.locator(`#role-${role}`);
  if (await radio.isChecked()) return;
  const done = page.waitForResponse((r) => r.url().endsWith("/api/role") && r.status() === 200);
  await radio.check();
  await done;
  await expect(radio).toBeChecked();
}

export async function newVisitor(browser: Browser, viewport = { width: 1440, height: 900 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, extraHTTPHeaders: { "cf-connecting-ip": uniqueIp() } });
  const page = await context.newPage();
  await openDesk(page);
  return { context, page };
}

export async function sandboxId(context: BrowserContext): Promise<string> {
  const cookie = (await context.cookies()).find((c) => c.name === "od_sbx");
  if (!cookie) throw new Error("no sandbox cookie");
  return cookie.value;
}

/** Calls the API with the page's cookies (same origin, JSON). */
export async function apiCall(request: APIRequestContext, method: string, path: string, body?: unknown) {
  const res = await request.fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    data: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status(), data, headers: res.headers() };
}

export function inDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function newRequestBody(overrides: Record<string, unknown> = {}) {
  return {
    kind: "repair",
    title: "Replace the cracked door handle",
    details: "",
    location: "Back door",
    cost: "15",
    dueDate: inDays(3),
    checklist: ["Buy the handle", "Fit it"],
    tz: 0,
    ...overrides,
  };
}

/** Runs SQL against the local D1 the test server uses (same persist dir). Returns result rows. */
export function d1(sql: string): Array<Record<string, unknown>> {
  const root = process.cwd(); // npm test runs from the repo root
  const out = execFileSync(
    process.execPath,
    [join(root, "node_modules", "wrangler", "bin", "wrangler.js"), "d1", "execute", "DB", "--local", "--persist-to", join(root, ".wrangler", "test-state"), "--command", sql, "--json"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } },
  );
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[parsed.length - 1].results;
}

/** Like d1() but returns the error text instead of throwing. */
export function d1Error(sql: string): string {
  try {
    d1(sql);
    return "";
  } catch (err: any) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`;
  }
}

/** Minimal RFC 4180 parser (handles quotes, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r") continue;
    else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
