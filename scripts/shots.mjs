// Visual QA helper: screenshots of every view at 390 px and 1440 px for each role.
// Usage: node scripts/shots.mjs [baseUrl] [outDir]
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://127.0.0.1:8799";
const out = process.argv[3] ?? "test-results/shots";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.FV_BROWSER || undefined });
const errors = [];
for (const [w, hgt] of [[390, 844], [1440, 900]]) {
  for (const scheme of ["light", "dark"]) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: hgt },
      colorScheme: scheme,
      extraHTTPHeaders: { "cf-connecting-ip": `10.250.${w % 250}.${scheme === "light" ? 1 : 2}` },
    });
    const page = await ctx.newPage();
    page.on("console", (m) => m.type() === "error" && errors.push(`${w} ${scheme}: ${m.text()}`));
    page.on("pageerror", (e) => errors.push(`${w} ${scheme}: ${e.message}`));
    const shot = async (name) => {
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${out}/${w}-${scheme}-${name}.png`, fullPage: true });
    };
    await page.goto(base + "/#/requests");
    await page.waitForSelector("html[data-ready]");
    await shot("staff-requests");
    if (scheme === "dark") { await ctx.close(); continue; }
    await page.goto(base + "/#/r/104");
    await page.waitForSelector(".sheet");
    await shot("staff-r104");
    await page.goto(base + "/#/new");
    await page.waitForSelector("form");
    await shot("staff-new");
    await page.check('#role-manager');
    await page.waitForTimeout(300);
    await page.goto(base + "/#/r/101");
    await page.waitForSelector(".sheet");
    await shot("manager-r101");
    await page.goto(base + "/#/r/108");
    await page.waitForSelector(".sheet");
    await shot("manager-r108");
    await page.check('#role-owner');
    await page.waitForTimeout(300);
    await page.goto(base + "/#/dashboard");
    await page.waitForSelector(".figures");
    await shot("owner-dashboard");
    await page.goto(base + "/#/log");
    await page.waitForSelector(".chain");
    await shot("owner-log");
    await page.goto(base + "/#/alerts");
    await page.waitForSelector(".outbound");
    await shot("owner-alerts");
    await page.goto(base + "/#/r/106");
    await page.waitForSelector(".sheet");
    await shot("owner-r106");
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? errors.join("\n") : "no console errors");
