// Input caps, row caps, sandbox-creation caps and "user text is never HTML".
import { apiCall, asRole, expect, newRequestBody, openDesk, test, uniqueIp } from "./helpers";

test("form fields carry the same caps as the server", async ({ page }) => {
  await openDesk(page, "#/new");
  await expect(page.locator("#title")).toHaveAttribute("maxlength", "80");
  await expect(page.locator("#details")).toHaveAttribute("maxlength", "500");
  await expect(page.locator("#location")).toHaveAttribute("maxlength", "60");
  await expect(page.locator("#item-1")).toHaveAttribute("maxlength", "80");

  await page.fill("#title", "x".repeat(120));
  await expect(page.locator("#title")).toHaveValue("x".repeat(80));
  await expect(page.locator("#title-count")).toHaveText("80/80");

  for (let i = 1; i < 12; i++) await page.click("#add-item");
  await expect(page.locator("#items li")).toHaveCount(12);
  await expect(page.locator("#add-item")).toBeDisabled();
  await expect(page.locator("#items-hint")).toHaveText("That is the maximum of 12 items.");

  await asRole(page, "manager");
  await page.goto("/#/r/102");
  await expect(page.locator("#note")).toHaveAttribute("maxlength", "280");
});

test("the API rejects over-long and malformed input with a field name", async ({ page }) => {
  await openDesk(page);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ title: "x".repeat(81) }, "title"],
    [{ title: "   " }, "title"],
    [{ title: "bell\u0007" }, "title"],
    [{ details: "x".repeat(501) }, "details"],
    [{ location: "x".repeat(61) }, "location"],
    [{ checklist: Array(13).fill("step") }, "checklist"],
    [{ checklist: ["x".repeat(81)] }, "checklist"],
    [{ checklist: [] }, "checklist"],
    [{ checklist: "not a list" }, "checklist"],
    [{ kind: "bribe" }, "kind"],
    [{ cost: "1e9" }, "cost"],
    [{ cost: "100000.01" }, "cost"],
    [{ dueDate: "2020-01-01" }, "dueDate"],
    [{ dueDate: "2026-02-30" }, "dueDate"],
  ];
  for (const [patch, field] of cases) {
    const res = await apiCall(page.request, "POST", "/requests", newRequestBody(patch));
    expect(res.status, JSON.stringify(patch).slice(0, 60)).toBe(400);
    expect(res.data.error.code).toBe("invalid_input");
    expect(res.data.error.field).toBe(field);
  }

  // Exactly at the limits is fine.
  const atLimit = await apiCall(page.request, "POST", "/requests", newRequestBody({
    title: "t".repeat(80),
    details: "d".repeat(500),
    location: "l".repeat(60),
    checklist: Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(80, "c")),
  }));
  expect(atLimit.status).toBe(201);

  // Body size, content type, JSON shape, cross-site writes.
  const big = await page.request.fetch("/api/requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    data: JSON.stringify(newRequestBody({ details: "x".repeat(9000) })),
  });
  expect(big.status()).toBe(413);
  const form = await page.request.fetch("/api/requests", { method: "POST", headers: { "content-type": "text/plain" }, data: "title=x" });
  expect(form.status()).toBe(415);
  const broken = await page.request.fetch("/api/requests", { method: "POST", headers: { "content-type": "application/json" }, data: "{nope" });
  expect(broken.status()).toBe(400);
  expect((await broken.json()).error.code).toBe("invalid_json");
  const crossSite = await page.request.fetch("/api/requests", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    data: JSON.stringify(newRequestBody()),
  });
  expect(crossSite.status()).toBe(403);

  await asRole(page, "manager");
  const longNote = await apiCall(page.request, "POST", "/requests/102/decision", { decision: "approve", note: "n".repeat(281) });
  expect(longNote.status).toBe(400);
  expect(longNote.data.error.field).toBe("note");
});

test("user text is rendered as text, never as HTML", async ({ page }) => {
  await openDesk(page);
  const title = '<img src=x onerror="window.__xss=1"><b>bold</b>';
  const res = await apiCall(page.request, "POST", "/requests", newRequestBody({
    title,
    details: "<script>window.__xss=2</script>",
    location: "<u>back</u>",
    checklist: ['<a href="javascript:alert(1)">step</a>'],
  }));
  expect(res.status).toBe(201);

  await page.goto(`/#/r/${res.data.ref}`);
  await expect(page.locator("#sheet-h")).toHaveText(title);
  await expect(page.locator(".details")).toHaveText("<script>window.__xss=2</script>");
  await expect(page.locator(".check label").first()).toContainText('<a href="javascript:alert(1)">step</a>');
  await expect(page.locator(".ticket").filter({ hasText: "<b>bold</b>" })).toHaveCount(page.viewportSize()!.width >= 1000 ? 1 : 0);
  expect(await page.locator('main img[src="x"]').count()).toBe(0);
  expect(await page.locator("main b", { hasText: /^bold$/ }).count()).toBe(0);
  expect(await page.locator("main script").count()).toBe(0);
  expect(await page.locator('main a[href^="javascript"]').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
});

test("a sandbox stops growing at its row cap", async ({ page }) => {
  await openDesk(page);
  const session = (await apiCall(page.request, "GET", "/session")).data;
  const cap = session.limits.requestsPerSandbox;
  expect(cap).toBe(60);
  for (let i = 0; i < cap - 8; i++) {
    const res = await apiCall(page.request, "POST", "/requests", newRequestBody({ title: `Cap filler ${i}`, checklist: ["a"] }));
    expect(res.status).toBe(201);
  }
  const over = await apiCall(page.request, "POST", "/requests", newRequestBody({ title: "One too many" }));
  expect(over.status).toBe(409);
  expect(over.data.error.code).toBe("sandbox_full");

  // The form shows the same message.
  await page.goto("/#/new");
  await page.fill("#title", "Still one too many");
  await page.fill("#item-1", "a");
  await page.click("#file");
  await expect(page.locator(".form-error")).toContainText(`at most ${cap} requests`);
});

test("one network can open at most 20 new sandboxes a day", async ({ playwright, baseURL }) => {
  const ip = uniqueIp();
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) {
    // A fresh request context has no cookies, like a visitor who clears them every time.
    const req = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": ip } });
    const res = await req.get("/api/session");
    statuses.push(res.status());
    if (i === 20) {
      const body = await res.json();
      expect(body.error.code).toBe("sandbox_quota");
      expect(Number(res.headers()["retry-after"])).toBeGreaterThan(0);
    }
    await req.dispose();
  }
  expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
  expect(statuses[20]).toBe(429);

  const other = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "cf-connecting-ip": uniqueIp() } });
  expect((await other.get("/api/session")).status()).toBe(200);
  await other.dispose();
});
