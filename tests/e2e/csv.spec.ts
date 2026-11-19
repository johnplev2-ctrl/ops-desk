// CSV exports: exact columns, every row, spreadsheet-safe cells, and an audit chain anyone can recompute.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { apiCall, asRole, expect, newRequestBody, openDesk, parseCsv, test } from "./helpers";

const REQUEST_HEADER = [
  "ref", "kind", "title", "details", "location", "cost_eur", "status", "overdue", "due_at",
  "created_at", "created_by", "decided_at", "decided_by", "decision_note",
  "completed_at", "completed_by", "proof_photo", "checklist_done", "checklist_total",
];
const AUDIT_HEADER = ["seq", "at", "at_iso", "actor", "role", "action", "ref", "detail", "prev_hash", "hash"];

test("owner downloads the requests CSV with every row and spreadsheet-safe cells", async ({ page }) => {
  await openDesk(page);
  const formula = '=HYPERLINK("http://example.com","click")';
  const created = await apiCall(page.request, "POST", "/requests", newRequestBody({
    kind: "purchase",
    title: formula,
    details: 'Line one, with a comma\nLine "two"',
    cost: "12.5",
    checklist: ["@SUM(A1:A2)", "Plain step"],
  }));
  expect(created.status).toBe(201);

  await asRole(page, "owner");
  await page.click('[data-nav="dashboard"]');
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-requests")]);
  expect(download.suggestedFilename()).toMatch(/^ops-desk-requests-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile((await download.path())!, "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff); // BOM so Excel reads UTF-8

  const rows = parseCsv(text);
  expect(rows[0]).toEqual(REQUEST_HEADER);
  expect(rows.slice(1).map((r) => r[0])).toEqual(["R-101", "R-102", "R-103", "R-104", "R-105", "R-106", "R-107", "R-108", "R-109"]);
  for (const r of rows) expect(r).toHaveLength(REQUEST_HEADER.length);

  const col = (row: string[], name: string) => row[REQUEST_HEADER.indexOf(name)];
  const mine = rows.find((r) => r[0] === "R-109")!;
  expect(col(mine, "title")).toBe(`'${formula}`); // leading apostrophe: never evaluated as a formula
  expect(col(mine, "details")).toBe('Line one, with a comma\nLine "two"');
  expect(col(mine, "kind")).toBe("purchase");
  expect(col(mine, "cost_eur")).toBe("12.50");
  expect(col(mine, "status")).toBe("pending");
  expect(col(mine, "created_by")).toBe("Sam");
  expect(col(mine, "checklist_total")).toBe("2");

  const r108 = rows.find((r) => r[0] === "R-108")!;
  expect(col(r108, "status")).toBe("rejected");
  expect(col(r108, "decided_by")).toBe("Jordan");
  expect(col(r108, "decision_note")).toBe("Not this quarter. Get the current one serviced first.");
  const r106 = rows.find((r) => r[0] === "R-106")!;
  expect(col(r106, "status")).toBe("done");
  expect(col(r106, "proof_photo")).toBe("p5");
  expect(col(r106, "checklist_done")).toBe("2");
  const r103 = rows.find((r) => r[0] === "R-103")!;
  expect(col(r103, "overdue")).toBe("yes");
  expect(col(r103, "due_at")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("audit CSV has every entry and its hash chain recomputes outside the app", async ({ page }) => {
  await openDesk(page);
  await apiCall(page.request, "POST", "/requests", newRequestBody({ title: "Chain check, with a comma" }));
  await asRole(page, "owner");
  const verify = await apiCall(page.request, "GET", "/audit/verify");
  expect(verify.data.ok).toBe(true);

  await page.click('[data-nav="log"]');
  await expect(page.getByTestId("chain")).toContainText(`Chain intact: ${verify.data.count} entries`);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download CSV" }).click()]);
  const rows = parseCsv(await readFile((await download.path())!, "utf8"));
  expect(rows[0]).toEqual(AUDIT_HEADER);
  const entries = rows.slice(1);
  expect(entries).toHaveLength(verify.data.count);

  // Recompute with Node's own crypto, from the CSV alone.
  let prev = "GENESIS";
  entries.forEach((r, i) => {
    const [seq, at, , actor, role, action, ref, detail, prevHash, hash] = r;
    expect(Number(seq)).toBe(i + 1);
    expect(prevHash).toBe(prev);
    const canonical = JSON.stringify([Number(seq), Number(at), actor, role, action, ref === "" ? null : Number(ref), detail, prevHash]);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(hash);
    prev = hash;
  });
  expect(prev).toBe(verify.data.head);
  expect(entries[entries.length - 1][5]).toBe("request.created");
  expect(entries[entries.length - 1][7]).toContain("Chain check, with a comma");
});
