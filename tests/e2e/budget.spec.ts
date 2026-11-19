// The demo's daily D1 write budget: D1's free row-write quota is shared by the whole account,
// so a script hammering the public demo must hit the demo's own ceiling first.
import { createHash } from "node:crypto";
import { apiCall, d1, expect, newRequestBody, openDesk, test, uniqueIp } from "./helpers";

const DAY = 86_400_000;
const today = () => Math.floor(Date.now() / DAY);
const ipKey = (prefix: string, ip: string) => `${prefix}:${createHash("sha256").update(`${today()}|${ip}`).digest("hex").slice(0, 32)}`;
const counter = (bucket: string) => Number(d1(`SELECT COALESCE((SELECT n FROM mint_counters WHERE bucket = '${bucket}'), 0) AS n`)[0].n);
const setCounter = (bucket: string, n: number) =>
  d1(`INSERT INTO mint_counters (bucket, day, n) VALUES ('${bucket}', ${today()}, ${n}) ON CONFLICT (bucket) DO UPDATE SET n = excluded.n`);

test("every demo write is charged to today's row budget", async ({ page }) => {
  await openDesk(page);
  const before = counter(`rows:${today()}`);
  expect(before).toBeGreaterThanOrEqual(150); // at least this visitor's seed
  expect((await apiCall(page.request, "POST", "/requests", newRequestBody({ title: "Charged write" }))).status).toBe(201);
  await expect.poll(() => counter(`rows:${today()}`), { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 10);
});

test("when the day's demo budget is spent, writes and new sandboxes are refused and the UI says why", async ({ page, playwright, baseURL }) => {
  await openDesk(page);
  const bucket = `rows:${today()}`;
  const saved = counter(bucket);
  setCounter(bucket, 1_000_000_000_000);
  try {
    const write = await apiCall(page.request, "POST", "/requests", newRequestBody({ title: "Over budget" }));
    expect(write.status).toBe(429);
    expect(write.data.error.code).toBe("demo_budget");
    expect(Number(write.headers["retry-after"])).toBeGreaterThan(0);

    // Reading still works: the visitor can look around, just not write.
    expect((await apiCall(page.request, "GET", "/requests")).status).toBe(200);

    const stranger = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": uniqueIp() } });
    const fresh = await stranger.get("/api/session");
    expect(fresh.status()).toBe(429);
    expect((await fresh.json()).error.code).toBe("demo_budget");
    await stranger.dispose();

    await page.goto("/#/new");
    await page.fill("#title", "Over budget from the form");
    await page.fill("#item-1", "a");
    await page.click("#file");
    await expect(page.locator(".form-error")).toContainText("write budget");
  } finally {
    setCounter(bucket, saved);
  }
});

test("one network cannot spend the whole budget", async ({ playwright, baseURL }) => {
  const ip = uniqueIp();
  const req = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": ip } });
  expect((await req.get("/api/session")).status()).toBe(200);
  setCounter(ipKey("rowsip", ip), 4000);
  const refused = await apiCall(req, "POST", "/requests", newRequestBody({ title: "Over my share" }));
  expect(refused.status).toBe(429);
  expect(refused.data.error.code).toBe("demo_budget_ip");
  await req.dispose();

  const other = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": uniqueIp() } });
  expect((await other.get("/api/session")).status()).toBe(200);
  expect((await apiCall(other, "POST", "/requests", newRequestBody({ title: "My share is fine" }))).status).toBe(201);
  await other.dispose();
});

test("refused sandbox requests write nothing", async ({ playwright, baseURL }) => {
  const ip = uniqueIp();
  setCounter(ipKey("ip", ip), 20);
  const rowsBefore = counter(ipKey("rowsip", ip));
  for (let i = 0; i < 3; i++) {
    const req = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": ip } });
    const res = await req.get("/api/session");
    expect(res.status()).toBe(429);
    expect((await res.json()).error.code).toBe("sandbox_quota");
    await req.dispose();
  }
  expect(counter(ipKey("ip", ip))).toBe(20);
  expect(counter(ipKey("rowsip", ip))).toBe(rowsBefore);
});
