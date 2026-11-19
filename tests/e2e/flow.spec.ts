// The whole flow, driven through the UI, one role at a time. Runs at 390 px (phone) and 1440 px (desktop).
import { apiCall, asRole, expect, inDays, openDesk, test } from "./helpers";

function weekStartMs(now = Date.now()): number {
  const tz = new Date().getTimezoneOffset();
  const local = new Date(now - tz * 60_000);
  const dow = (local.getUTCDay() + 6) % 7;
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow) + tz * 60_000;
}

test("staff files, manager approves, staff completes with photo proof, owner sees it all", async ({ page }) => {
  await openDesk(page);

  // ---- staff ----
  await expect(page.locator("#role-staff")).toBeChecked();
  await expect(page.locator('[data-nav="dashboard"]')).toHaveCount(0);
  await expect(page.locator('[data-nav="log"]')).toHaveCount(0);
  await expect(page.locator(".ticket")).toHaveCount(8);

  await page.click('[data-nav="new"]');
  await expect(page.getByRole("heading", { level: 1, name: "New request" })).toBeVisible();
  await page.check("#kind-repair");
  await page.fill("#title", "Fix the leaking dishwasher hose");
  await page.fill("#details", "Puddle under the dishwasher after every cycle.");
  await page.fill("#location", "Kitchen");
  await page.fill("#cost", "45.90");
  await page.fill("#dueDate", inDays(3));
  await page.fill("#item-1", "Turn off the dishwasher supply");
  await page.click("#add-item");
  await page.fill("#item-2", "Replace the hose clamp");
  await page.click("#add-item");
  await page.fill("#item-3", "Run a test cycle");
  await page.click("#file");

  await expect(page).toHaveURL(/#\/r\/109$/);
  await expect(page.locator("#sheet-h")).toHaveText("Fix the leaking dishwasher hose");
  await expect(page.getByTestId("status")).toHaveText("Awaiting approval");
  await expect(page.locator(".facts")).toContainText("€45.90");
  await expect(page.locator("#approve")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Waiting for a decision" })).toBeVisible();
  await expect(page.locator("#chk-1")).toBeDisabled();
  await expect(page.locator("#mark-done")).toHaveCount(0);

  // ---- manager ----
  await asRole(page, "manager");
  await expect(page.locator('[data-nav="dashboard"]')).toHaveCount(1);
  await page.click('[data-nav="alerts"]');
  const firstAlert = page.locator(".alert").first();
  await expect(firstAlert).toContainText("R-109 needs approval: Fix the leaking dishwasher hose");
  await expect(firstAlert).toHaveClass(/unread/);
  await firstAlert.getByRole("link").click();
  await expect(page).toHaveURL(/#\/r\/109$/);
  await page.fill("#note", "Go ahead, use the spare clamp kit.");
  await page.click("#approve");
  await expect(page.getByTestId("stamp")).toContainText("Approved");
  await expect(page.getByTestId("status")).toHaveText("Approved");
  await expect(page.locator(".note")).toContainText("Go ahead, use the spare clamp kit.");
  await expect(page.locator("#chk-1")).toBeDisabled();

  // ---- staff completes ----
  await asRole(page, "staff");
  await expect(page.locator("#mark-done")).toBeDisabled();
  await expect(page.locator("#done-hint")).toContainText("Tick all 3 checklist items first");
  for (const n of [1, 2, 3]) {
    await page.check(`#chk-${n}`);
    await expect(page.locator(`#chk-${n}`)).toBeChecked();
    await expect(page.locator(`#chk-${n}`)).toBeEnabled();
  }
  await expect(page.locator("#mark-done")).toBeDisabled();
  await expect(page.locator("#done-hint")).toHaveText("Pick a proof photo to finish.");
  await page.check("#photo-p1");
  await expect(page.locator("#mark-done")).toBeEnabled();
  await page.click("#mark-done");
  await expect(page.getByTestId("stamp")).toContainText("Done");
  await expect(page.getByTestId("status")).toHaveText("Done");
  await expect(page.locator(".proof img")).toHaveAttribute("src", "/photos/p1.svg");
  await expect(page.locator(".trail li")).toHaveCount(6); // filed, approved, 3 ticks, done

  // ---- owner ----
  await asRole(page, "owner");
  const { data } = await apiCall(page.request, "GET", "/requests");
  const since = weekStartMs();
  const doneThisWeek = data.requests.filter((r: any) => r.status === "done" && r.completedAt >= since).length;
  expect(doneThisWeek).toBeGreaterThanOrEqual(1);

  await page.click('[data-nav="dashboard"]');
  await expect(page.locator('[data-figure="Awaiting approval"] .figure-n')).toHaveText("3");
  await expect(page.locator('[data-figure="Open"] .figure-n')).toHaveText("2");
  await expect(page.locator('[data-figure="Done this week"] .figure-n')).toHaveText(String(doneThisWeek));
  await expect(page.locator('[data-figure="Overdue"] .figure-n')).toHaveText("2");
  const overdue = page.locator(".overdue-list .ticket");
  await expect(overdue).toHaveCount(2);
  await expect(overdue.nth(0)).toContainText("R-103");
  await expect(overdue.nth(1)).toContainText("R-105");
  await expect(page.locator("#export-requests")).toBeVisible();
  await expect(page.locator("#export-audit")).toBeVisible();

  await page.click('[data-nav="log"]');
  await expect(page.getByTestId("chain")).toContainText("Chain intact");
  await expect(page.locator(".log li").first()).toContainText("Marked done R-109");
  await expect(page.locator(".log li").first()).toContainText("Sam, staff");

  await page.click('[data-nav="alerts"]');
  await expect(page.locator(".alert").first()).toContainText("R-109 done by Sam: Fix the leaking dishwasher hose");
  await page.locator(".alert").first().locator("summary").click();
  await expect(page.locator(".alert").first().locator("pre")).toContainText('"event": "request.done"');
  await expect(page.getByTestId("outbound")).toContainText("stubbed");
});

test("rejecting needs a note, and staff see the reason", async ({ page }) => {
  await openDesk(page);
  await asRole(page, "manager");
  await page.goto("/#/r/101");
  await page.click("#reject");
  await expect(page.locator("#note-error")).toHaveText("Add a note so staff know why it was rejected.");
  await expect(page.locator("#note")).toBeFocused();
  await expect(page.getByTestId("status")).toHaveText("Awaiting approval");

  await page.fill("#note", "Call the landlord first, it may be covered.");
  await page.click("#reject");
  await expect(page.getByTestId("stamp")).toContainText("Rejected");
  await expect(page.locator(".note")).toContainText("Call the landlord first");

  await asRole(page, "staff");
  await page.click('[data-nav="alerts"]');
  await expect(page.locator(".alert").first()).toContainText("R-101 rejected by Alex");
  await page.goto("/#/r/101");
  await expect(page.locator(".note")).toContainText("Call the landlord first, it may be covered.");
  await expect(page.locator("#check-hint")).toContainText("rejected");
  await expect(page.locator("#chk-1")).toBeDisabled();
});

test("roles are enforced by the API, not only hidden in the UI", async ({ page }) => {
  await openDesk(page);
  const api = (m: string, p: string, b?: unknown) => apiCall(page.request, m, p, b);

  // staff
  expect((await api("GET", "/dashboard")).status).toBe(403);
  expect((await api("GET", "/audit")).status).toBe(403);
  expect((await api("GET", "/export/requests.csv")).status).toBe(403);
  expect((await api("POST", "/requests/101/decision", { decision: "approve", note: "" })).status).toBe(403);
  await page.goto("/#/dashboard");
  await expect(page).toHaveURL(/#\/requests$/);

  // manager
  await asRole(page, "manager");
  expect((await api("GET", "/dashboard")).status).toBe(200);
  expect((await api("POST", "/requests/104/checklist/3", { done: true })).status).toBe(403);
  expect((await api("POST", "/requests/104/complete", { photo: "p4" })).status).toBe(403);
  expect((await api("GET", "/export/audit.csv")).status).toBe(403);

  // owner
  await asRole(page, "owner");
  expect((await api("POST", "/requests", { kind: "task", title: "x", dueDate: "2099-01-01", checklist: ["a"] })).status).toBe(403);
  expect((await api("GET", "/export/requests.csv")).status).toBe(200);
  await page.goto("/#/new");
  await expect(page).toHaveURL(/#\/requests$/);

  // state rules hold for the right role too
  await asRole(page, "staff");
  const early = await api("POST", "/requests/101/checklist/1", { done: true });
  expect(early.status).toBe(409);
  expect(early.data.error.message).toContain("opens once R-101 is approved");
  const incomplete = await api("POST", "/requests/104/complete", { photo: "p4" });
  expect(incomplete.status).toBe(409);
  expect(incomplete.data.error.code).toBe("checklist_incomplete");
  const noPhoto = await api("POST", "/requests/106/complete", { photo: "upload.jpg" });
  expect(noPhoto.status).toBe(400);
});
