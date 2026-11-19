// Accessibility: axe-core WCAG 2.1 A/AA rules (including colour contrast) on every view, light and dark,
// plus keyboard basics. Runs at 390 px and 1440 px.
import AxeBuilder from "@axe-core/playwright";
import { asRole, expect, openDesk, test, type Role } from "./helpers";

const VIEWS: Array<[Role, string, string]> = [
  ["staff", "#/requests", "h1"],
  ["staff", "#/r/104", "#sheet-h"],
  ["staff", "#/new", "h1"],
  ["manager", "#/r/101", "#sheet-h"],
  ["manager", "#/r/108", "#sheet-h"],
  ["owner", "#/dashboard", "h1"],
  ["owner", "#/log", "h1"],
  ["owner", "#/alerts", "h1"],
  ["owner", "#/r/106", "#sheet-h"],
];

for (const scheme of ["light", "dark"] as const) {
  test(`every view passes axe WCAG 2.1 AA checks (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await openDesk(page);
    for (const [role, hash, ready] of VIEWS) {
      await asRole(page, role);
      await page.goto(`/${hash}`);
      await expect(page.locator(ready).first()).toBeVisible();
      await page.locator(".toast").evaluate((el) => el.classList.remove("show"));
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const problems = result.violations.map((v) => `${role} ${hash} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      expect(problems).toEqual([]);
    }
  });
}

test("keyboard: skip link, visible focus, and the role switcher works without a mouse", async ({ page }) => {
  await openDesk(page);
  await page.keyboard.press("Tab");
  const skip = page.locator(".skip");
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  await page.locator("#role-staff").focus();
  const outline = await page.locator("#role-staff + label").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
  const done = page.waitForResponse((r) => r.url().endsWith("/api/role"));
  await page.keyboard.press("ArrowRight");
  await done;
  await expect(page.locator("#role-manager")).toBeChecked();
  await expect(page.locator('[data-nav="dashboard"]')).toHaveCount(1);
});

test("no horizontal scrolling on any view", async ({ page }) => {
  await openDesk(page);
  for (const [role, hash, ready] of VIEWS) {
    await asRole(page, role);
    await page.goto(`/${hash}`);
    await expect(page.locator(ready).first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${role} ${hash}`).toBeLessThanOrEqual(0);
  }
});
