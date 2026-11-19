// Sandbox isolation: two visitors (two browser contexts) never see each other's rows.
import { apiCall, asRole, d1, expect, newRequestBody, newVisitor, openDesk, sandboxId, test, uniqueIp } from "./helpers";

test("two visitors get separate sandboxes and cannot see each other's rows", async ({ browser }) => {
  const a = await newVisitor(browser);
  const b = await newVisitor(browser);
  const idA = await sandboxId(a.context);
  const idB = await sandboxId(b.context);
  expect(idA).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(idA).not.toBe(idB);

  const marker = `Isolation marker ${Date.now()}`;
  const created = await apiCall(a.page.request, "POST", "/requests", newRequestBody({ title: marker }));
  expect(created.status).toBe(201);
  const ref = created.data.ref;

  // A sees it, in the API and the UI.
  expect(JSON.stringify((await apiCall(a.page.request, "GET", "/requests")).data)).toContain(marker);
  await a.page.reload();
  await expect(a.page.getByText(marker)).toHaveCount(1);

  // B does not: list, direct fetch by the same number, actions on it, UI, exports, audit log.
  const listB = await apiCall(b.page.request, "GET", "/requests");
  expect(listB.data.requests).toHaveLength(8);
  expect(JSON.stringify(listB.data)).not.toContain(marker);
  const getB = await apiCall(b.page.request, "GET", `/requests/${ref}`);
  expect(getB.status).toBe(404);
  await b.page.reload();
  await expect(b.page.getByText(marker)).toHaveCount(0);

  await asRole(b.page, "manager");
  expect((await apiCall(b.page.request, "POST", `/requests/${ref}/decision`, { decision: "approve", note: "" })).status).toBe(404);
  await asRole(b.page, "owner");
  const csvB = await b.page.request.get("/api/export/requests.csv");
  expect(await csvB.text()).not.toContain(marker);
  const auditB = await b.page.request.get("/api/export/audit.csv");
  expect(await auditB.text()).not.toContain(marker);

  // A's role switch did not change B, and B's did not change A.
  const sessionA = await apiCall(a.page.request, "GET", "/session");
  expect(sessionA.data.role).toBe("staff");

  // In the database the row exists exactly once, scoped to A.
  const rows = d1(`SELECT sandbox_id FROM requests WHERE title = '${marker}'`);
  expect(rows).toEqual([{ sandbox_id: idA }]);

  await a.context.close();
  await b.context.close();
});

test("a forged or guessed sandbox cookie never opens someone else's sandbox", async ({ browser, baseURL }) => {
  const victim = await newVisitor(browser);
  const victimId = await sandboxId(victim.context);
  const nearMiss = victimId.slice(0, -1) + (victimId.endsWith("A") ? "B" : "A");

  for (const forged of ["main", "x", "AAAAAAAAAAAAAAAAAAAAAA", nearMiss]) {
    const context = await browser.newContext({ extraHTTPHeaders: { "cf-connecting-ip": uniqueIp() } });
    await context.addCookies([{ name: "od_sbx", value: forged, url: baseURL! }]);
    const page = await context.newPage();
    const probe = await apiCall(page.request, "GET", "/requests");
    expect(probe.status).toBe(401);
    expect(probe.data.error.code).toBe("no_sandbox");

    await openDesk(page);
    const id = await sandboxId(context);
    expect(id).not.toBe(victimId);
    expect(id).not.toBe(forged);
    await context.close();
  }
  await victim.context.close();
});

test("resetting a sandbox deletes its rows and starts again from the template", async ({ page, context }) => {
  await openDesk(page);
  const oldId = await sandboxId(context);
  await apiCall(page.request, "POST", "/requests", newRequestBody({ title: "Gone after reset" }));
  await page.reload();
  await expect(page.getByText("Gone after reset")).toHaveCount(1);

  page.once("dialog", (d) => d.accept());
  await page.click("#reset");
  await expect(page.locator(".ticket")).toHaveCount(8);
  await expect(page.getByText("Gone after reset")).toHaveCount(0);
  const newId = await sandboxId(context);
  expect(newId).not.toBe(oldId);
  const left = d1(
    `SELECT (SELECT COUNT(*) FROM sandboxes WHERE id = '${oldId}') + (SELECT COUNT(*) FROM requests WHERE sandbox_id = '${oldId}')
       + (SELECT COUNT(*) FROM audit_log WHERE sandbox_id = '${oldId}') + (SELECT COUNT(*) FROM alerts WHERE sandbox_id = '${oldId}')
       + (SELECT COUNT(*) FROM checklist_items WHERE sandbox_id = '${oldId}') AS n`,
  );
  expect(left[0].n).toBe(0);
});
