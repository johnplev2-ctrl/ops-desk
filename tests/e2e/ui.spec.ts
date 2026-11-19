// Layout regressions found in the visual review (19 Nov 2026).
import { asRole, expect, openDesk, test } from "./helpers";

test("every filter chip is fully visible, none clipped", async ({ page }) => {
  await openDesk(page);
  const chips = page.locator(".filters a");
  await expect(chips).toHaveCount(6);
  const pane = await page.locator(".filters").boundingBox();
  for (let i = 0; i < 6; i++) {
    const box = (await chips.nth(i).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(pane!.x - 1);
    expect(box.x + box.width, `chip ${i + 1}`).toBeLessThanOrEqual(pane!.x + pane!.width + 1);
    await expect(chips.nth(i)).toBeInViewport();
  }
});

test("finished cards say when they finished, not a past-tense due date in the future", async ({ page }) => {
  await openDesk(page);
  await expect(page.locator(".ticket", { hasText: "R-108" })).toContainText(/Rejected \w{3} \d{1,2} \w{3}/);
  await expect(page.locator(".ticket", { hasText: "R-106" })).toContainText(/Done \w{3} \d{1,2} \w{3}/);
  await expect(page.locator(".ticket").filter({ hasText: "Was due" })).toHaveCount(0);
});

test("the audit log hides 'Load older entries' when everything is already shown", async ({ page }) => {
  await openDesk(page);
  await asRole(page, "owner");
  await page.goto("/#/log");
  await expect(page.locator(".chain")).toBeVisible();
  await expect(page.locator("#load-older")).toBeHidden();
});

test("the empty detail pane explains the flow on wide screens and stays out of the way on phones", async ({ page }) => {
  await openDesk(page);
  const pane = page.locator(".detail-empty");
  if ((page.viewportSize()?.width ?? 0) >= 1000) {
    await expect(pane).toBeVisible();
    await expect(pane.locator("li")).toHaveCount(4);
  } else {
    await expect(pane).toBeHidden();
  }
});
