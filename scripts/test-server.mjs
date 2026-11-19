// Starts a clean local stack for the Playwright suite:
// fresh local D1 in .wrangler/test-state, migrations applied, then `wrangler pages dev`.
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const persist = join(root, ".wrangler", "test-state");
const port = process.env.PORT ?? "8799";

rmSync(persist, { recursive: true, force: true });

const migrate = spawnSync(process.execPath, [wrangler, "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, CI: "1" },
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

// The suite runs against the real wrangler.jsonc per-network limits. Each test context sends its own
// CF-Connecting-IP header (local dev passes it through), so the per-IP caps are exercised as configured.
// TEST_BINDINGS (set in playwright.config.ts) lifts only the all-visitor daily caps, because one suite run
// is hundreds of visitors; tests/e2e/budget.spec.ts drives those caps by setting their counters directly.
const bindings = (process.env.TEST_BINDINGS ?? "").split(",").filter(Boolean);

const dev = spawn(
  process.execPath,
  [wrangler, "pages", "dev", "--ip", "127.0.0.1", "--port", port, "--persist-to", persist, "--show-interactive-dev-session=false", ...bindings.flatMap((b) => ["--binding", b])],
  { cwd: root, stdio: "inherit", env: { ...process.env, CI: "1" } },
);

const stop = () => {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" });
  else dev.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
dev.on("exit", (code) => process.exit(code ?? 0));
