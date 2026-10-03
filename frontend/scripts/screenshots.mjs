// Before/after screenshots of every page, both roles, at 1280px and 1024px.
// LOCAL STACK ONLY: refuses any base URL that is not localhost.
//
//   node scripts/screenshots.mjs <phase> <label>      e.g.  node scripts/screenshots.mjs phase1 before
//
// Credentials come from the repo-root .env.local (written by `python -m scripts.local_stack`).
// Output: ../output/screenshots/<phase>/<label>/<role>-<page>-<width>.png (+ report.json with
// horizontal-overflow checks). /output is gitignored.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const [phase = "adhoc", label = "now"] = process.argv.slice(2);
const BASE = process.env.CASELENS_BASE_URL ?? "http://localhost:5173";
if (!["localhost", "127.0.0.1"].includes(new URL(BASE).hostname)) {
  console.error("refusing: screenshots are only taken from the local stack");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(join(root, ".env.local"), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const WIDTHS = [1280, 1024];
const PAGES = {
  manager: [
    { name: "overview", path: "/" },
    { name: "cases", path: "/cases" },
    { name: "review", path: "/review" },
    { name: "case-00100016", path: "/cases", open: "00100016" },
    { name: "case-00100002", path: "/cases", open: "00100002" },
    { name: "case-00100013", path: "/cases", open: "00100013" },
  ],
  tse: [
    { name: "overview", path: "/" },
    { name: "cases", path: "/cases" },
    { name: "case-00100016", path: "/cases", open: "00100016" },
  ],
};

const out = join(root, "output", "screenshots", phase, label);
mkdirSync(out, { recursive: true });
const report = [];

const browser = await chromium.launch({ channel: "msedge", headless: true });
for (const role of ["manager", "tse"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.fill('input[type="email"]', env[`LOCAL_${role.toUpperCase()}_EMAIL`]);
  await page.fill('input[type="password"]', env[`LOCAL_${role.toUpperCase()}_PASSWORD`]);
  await page.press('input[type="password"]', "Enter");
  await page.waitForSelector("header nav", { timeout: 15000 });

  for (const p of PAGES[role]) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(BASE + p.path);
      await page.waitForLoadState("networkidle");
      if (p.open) {
        await page.getByText(p.open, { exact: true }).first().click();
        await page.waitForLoadState("networkidle");
      }
      await page.waitForTimeout(1200); // chart animations
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      // Content checks: tables that scroll sideways inside their panel, raw enum codes, and "mock"
      // anywhere outside the Run details popover.
      const scan = await page.evaluate(() => {
        const scrollers = [...document.querySelectorAll(".overflow-x-auto")]
          .filter((el) => el.querySelector("table") && el.scrollWidth > el.clientWidth + 1).length;
        const main = document.querySelector("main")?.cloneNode(true);
        main?.querySelectorAll("[data-testid=run-details]").forEach((n) => n.remove());
        const text = main?.textContent ?? "";
        return {
          tableScrollers: scrollers,
          rawCodes: [...new Set(text.match(/\b[A-Z]{2,}(?:_[A-Z]+)+\b/g) ?? [])],
          mockMentions: (text.match(/mock/gi) ?? []).length,
          legacyShort: /\bn\/[ad]\b/.test(text),
        };
      });
      const file = `${role}-${p.name}-${width}.png`;
      await page.screenshot({ path: join(out, file), fullPage: true });
      report.push({ role, page: p.name, width, horizontalOverflowPx: Math.max(0, overflow), ...scan, file });
      const issues = [overflow > 0 && `page overflow ${overflow}px`, scan.tableScrollers && `${scan.tableScrollers} table(s) scroll sideways`,
        scan.rawCodes.length && `raw codes ${scan.rawCodes.join(",")}`, scan.mockMentions && `"mock" x${scan.mockMentions}`,
        scan.legacyShort && "n/a or n/d"].filter(Boolean);
      console.log(`${file}${issues.length ? `  (${issues.join("; ")})` : ""}`);
    }
  }
  await ctx.close();
}
await browser.close();
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
