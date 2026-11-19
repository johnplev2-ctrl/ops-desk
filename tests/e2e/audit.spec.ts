// Append-only audit log: enforced by the API surface and by the database itself. Plus retention purge.
import { apiCall, asRole, d1, d1Error, expect, newRequestBody, openDesk, sandboxId, test } from "./helpers";

test("each action appends exactly one entry and earlier entries never change", async ({ page }) => {
  await openDesk(page);
  await asRole(page, "owner");
  const before = (await apiCall(page.request, "GET", "/audit?limit=100")).data.entries;
  expect(before.length).toBeGreaterThan(10);

  await asRole(page, "manager");
  expect((await apiCall(page.request, "POST", "/requests/101/decision", { decision: "approve", note: "Fine." })).status).toBe(200);
  // A refused action and a no-op write nothing.
  expect((await apiCall(page.request, "POST", "/requests/101/decision", { decision: "reject", note: "Changed my mind" })).status).toBe(409);
  await asRole(page, "staff");
  expect((await apiCall(page.request, "POST", "/requests/104/checklist/1", { done: true })).status).toBe(200); // already ticked

  await asRole(page, "owner");
  const after = (await apiCall(page.request, "GET", "/audit?limit=100")).data.entries;
  expect(after).toHaveLength(before.length + 1);
  expect(after.slice(1)).toEqual(before);
  expect(after[0]).toMatchObject({
    seq: before[0].seq + 1,
    action: "request.approved",
    ref: 101,
    actor: "Alex",
    role: "manager",
    detail: 'Approved with note "Fine."',
    prev_hash: before[0].hash,
  });
  expect((await apiCall(page.request, "GET", "/audit/verify")).data.ok).toBe(true);
});

test("the API offers no way to edit or delete audit entries", async ({ page }) => {
  await openDesk(page);
  await asRole(page, "owner");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await apiCall(page.request, method, "/audit", method === "DELETE" ? undefined : { seq: 1, detail: "tampered" });
    expect(res.status, `${method} /audit`).toBe(405);
    expect(res.headers.allow).toBe("GET");
  }
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    expect((await apiCall(page.request, method, "/audit/1")).status, `${method} /audit/1`).toBe(404);
  }
  expect((await apiCall(page.request, "GET", "/audit/verify")).data.ok).toBe(true);
});

test("the database itself refuses audit updates, deletes and out-of-chain inserts", async ({ page, context }) => {
  await openDesk(page);
  const sid = await sandboxId(context);
  const fakeHash = "a".repeat(64);

  expect(d1Error(`UPDATE audit_log SET detail = 'tampered' WHERE sandbox_id = '${sid}' AND seq = 1`)).toContain("append-only: updates are not allowed");
  expect(d1Error(`DELETE FROM audit_log WHERE sandbox_id = '${sid}' AND seq = 1`)).toContain("append-only: deletes are not allowed");
  // Re-using an existing seq, skipping ahead, or a prev_hash that is not the head's hash.
  expect(d1Error(`INSERT INTO audit_log (sandbox_id, seq, at, actor, role, action, ref, detail, prev_hash, hash) VALUES ('${sid}', 1, 0, 'x', 'staff', 'x', NULL, '', 'GENESIS', '${fakeHash}')`)).toContain("does not extend the chain");
  expect(d1Error(`INSERT INTO audit_log (sandbox_id, seq, at, actor, role, action, ref, detail, prev_hash, hash) VALUES ('${sid}', 999, 0, 'x', 'staff', 'x', NULL, '', 'GENESIS', '${fakeHash}')`)).toContain("does not extend the chain");
  const head = d1(`SELECT MAX(seq) AS seq FROM audit_log WHERE sandbox_id = '${sid}'`)[0].seq as number;
  expect(d1Error(`INSERT INTO audit_log (sandbox_id, seq, at, actor, role, action, ref, detail, prev_hash, hash) VALUES ('${sid}', ${head + 1}, 0, 'x', 'staff', 'x', NULL, '', '${fakeHash}', '${fakeHash}')`)).toContain("does not extend the chain");

  await asRole(page, "owner");
  const check = await apiCall(page.request, "GET", "/audit/verify");
  expect(check.data).toMatchObject({ ok: true, count: head });
});

test("sandboxes older than 24 h are purged and the visitor gets a fresh one", async ({ page, context }) => {
  await openDesk(page);
  const oldId = await sandboxId(context);
  await apiCall(page.request, "POST", "/requests", newRequestBody({ title: "Old enough to purge" }));

  d1(`UPDATE sandboxes SET created_at = created_at - 25 * 3600 * 1000 WHERE id = '${oldId}'`);
  const expired = await apiCall(page.request, "GET", "/requests");
  expect(expired.status).toBe(401);
  expect(expired.data.error.code).toBe("no_sandbox");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  const newId = await sandboxId(context);
  expect(newId).not.toBe(oldId);
  await expect(page.locator(".ticket")).toHaveCount(8);
  await expect(page.getByText("Old enough to purge")).toHaveCount(0);

  const remaining = () =>
    Number(
      d1(
        `SELECT (SELECT COUNT(*) FROM sandboxes WHERE id = '${oldId}') + (SELECT COUNT(*) FROM requests WHERE sandbox_id = '${oldId}')
           + (SELECT COUNT(*) FROM checklist_items WHERE sandbox_id = '${oldId}') + (SELECT COUNT(*) FROM alerts WHERE sandbox_id = '${oldId}')
           + (SELECT COUNT(*) FROM audit_log WHERE sandbox_id = '${oldId}') AS n`,
      )[0].n,
    );
  await expect.poll(remaining, { timeout: 30_000, intervals: [500, 1000, 2000] }).toBe(0);
});
