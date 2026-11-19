# Ops desk

A small-business operations desk on Cloudflare Pages + Pages Functions + D1.

Staff file a request (repair, purchase or task) with a checklist. A manager approves or rejects it with a note. Staff tick the checklist and finish with photo proof. The owner gets a dashboard (awaiting approval, open, done this week, overdue). Every action lands in an append-only, hash-chained audit log, and requests and the audit log export to CSV. Alerts show in an in-app feed; an outbound webhook/Telegram adapter is included and stubbed in the demo.

The public demo gives every visitor a private sandbox filled with generic demo data ("Corner Café"). Every name, request and number in it is invented.

Built by Giannis Plevris with Claude Code.

## 60-second tour

1. **Staff (Sam).** Open **New request**, pick *Repair*, give it a title and a few checklist steps, then select **File request**. It lands as *R-109, Awaiting approval*. The checklist stays locked.
2. **Manager (Alex).** Switch role at the top. **Alerts** shows "R-109 needs approval". Open it, add a note, select **Approve**. The ticket gets an *Approved* stamp.
3. **Staff again.** Tick every checklist item, pick one of the six sample photos (uploads are off in the public demo), select **Mark done**.
4. **Owner (Jordan).** **Dashboard** shows the four counts and the overdue list (R-103 and R-105 are seeded overdue). **Audit log** shows every step with its hash and "Chain intact". Download both CSVs. **Alerts** shows the message the Telegram/webhook adapter *would* have sent.
5. **Reset sandbox** starts over from the template.

## Architecture

```
 Browser (vanilla JS, no framework, ~12 KB gzipped)
   │  same-origin fetch, JSON, cookies: od_sbx (sandbox), od_role (demo role)
   ▼
 Cloudflare Pages ──── static: public/  (HTML, CSS, JS, font, 6 SVG sample photos)
   │                    _headers: CSP default-src 'none' + self only, no framing
   │  /api/*  only (functions/api/[[path]].ts), so static files never run a Function
   ▼
 Pages Function ─ src/router.ts
   ├─ identity.ts   resolveIdentity(): Access JWT (prod) ─or─ role cookie (demo)
   ├─ sandbox.ts    per-visitor sandbox, seed, 24 h purge, creation caps
   ├─ desk.ts       requests · decisions · checklist · completion · dashboard · CSV
   ├─ audit.ts      SHA-256 hash chain, verify
   └─ alerts.ts     in-app feed + outbound adapter: stub | webhook | telegram
   │  every write = one D1 batch (one transaction) incl. its audit entry
   ▼
 D1 (SQLite) ─ migrations/0001_init.sql, 0002_protect_main_desk.sql
   sandboxes · requests · checklist_items · audit_log · alerts · mint_counters
   triggers: audit_log rejects UPDATE, DELETE (while its sandbox exists) and any
             INSERT that is not "next seq + previous hash"
```

## Security model

**Identity and roles.** One function decides who the caller is: `resolveIdentity()` in `src/identity.ts`.

- *Production* (`DEMO_MODE=false`): the site sits behind Cloudflare Access. Access sends a signed JWT in the `Cf-Access-Jwt-Assertion` header; the function verifies it (RS256 against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; `aud`, `iss`, `exp`, `nbf` checked) and maps the verified `email` to a role through `ROLE_MAP` (exact email first, then `*@domain`). No header, a bad token or an unmapped email is refused. The demo cookie is never consulted. ([Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [application token claims](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/))
- *Demo* (`DEMO_MODE=true`): no login. The role switcher sets an `od_role` cookie; anyone can be any role inside their own sandbox.

Permissions are checked on the server for every call, not only hidden in the UI:

| Action | Staff | Manager | Owner |
|---|:-:|:-:|:-:|
| File a request | ✓ | ✓ | |
| Approve / reject (reject needs a note) | | ✓ | ✓ |
| Tick checklist, mark done with photo | ✓ | | |
| Dashboard, audit log | | ✓ | ✓ |
| CSV export | | | ✓ |

**Sandbox isolation (demo).** The first `GET /api/session` creates a sandbox: a 128-bit id from `crypto.getRandomValues`, stored in an `HttpOnly; SameSite=Lax` cookie (`Secure` on HTTPS). Every row has `sandbox_id` and every query filters on it. A cookie that is not a well-formed id of a live sandbox gets nothing (401) and the app opens a fresh sandbox instead; it never falls through to another one.

**Abuse limits (demo).** Sandboxes are deleted 24 h after creation, opportunistically (on sandbox creation and on roughly 1 in 25 API calls, in `waitUntil`). Per sandbox: 60 requests, 1,500 audit entries, 400 alerts. Per network: 20 new sandboxes per UTC day; 100 new sandboxes per day in total. The IP is stored only as a truncated SHA-256 of day + IP and deleted the next day; a refused attempt writes nothing.

**Write budget (demo).** D1's free row-write quota belongs to the whole Cloudflare account, not to one database, so a script hammering a public demo could stop every other D1 app on the account until 00:00 UTC. The demo therefore keeps its own ledger of rows written per UTC day (`DEMO_ROWS_PER_DAY`, default 25,000, a quarter of the free quota) and per network (`DEMO_ROWS_PER_IP_PER_DAY`, default 4,000). Every seed, action, reset and purge adds its measured `rows_written`. Once a limit is reached, writes and new sandboxes get `429` with `Retry-After` until 00:00 UTC; reading keeps working. Production mode has no budget. Inputs: title 80, details 500, location 60, note 280 characters, 12 checklist items of 80, JSON bodies up to 8 KB, enforced in the API and again by `CHECK` constraints. No uploads: proof is one of six bundled images.

**Output.** User text only ever reaches the page through `textContent`; the front end has no `innerHTML`. CSP allows scripts, styles, images and fonts from the site itself only. CSV cells that start with `=`, `+`, `-`, `@`, tab or CR get a leading apostrophe so spreadsheets never run them as formulas.

**Writes.** Non-GET calls must be `application/json` and same-origin (`Origin` / `Sec-Fetch-Site`). Each write reads the audit head, then commits its change and the next audit entry in one D1 batch; if anything else wrote in between, the chain insert fails, the whole batch rolls back, and the caller gets 409.

**Audit log.** Append-only at two levels: the API has no route that edits or deletes entries, and D1 triggers reject `UPDATE`, reject `DELETE` while the sandbox exists, and reject any insert that is not the next sequence number carrying the previous entry's hash. The production desk's own row cannot be deleted (`migrations/0002_protect_main_desk.sql`), so its entries can never become deletable. Triggers stop the app and casual SQL, not a database admin: someone who can run `DROP TRIGGER` on your D1 can rewrite history. What catches that is the chain itself. Keep the last hash from an exported audit CSV somewhere else; if a later export no longer contains that hash at that `seq`, history was changed. Each hash is SHA-256 of `JSON.stringify([seq, at, actor, role, action, ref, detail, prev_hash])`, so the exported CSV can be checked with any SHA-256 tool. The only deletion is the demo's 24 h sandbox purge, which removes the sandbox row first and then all of its rows.

**Secrets.** None in the repo. The real alert adapters read `ALERT_WEBHOOK_URL` or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` from Pages secrets; demo mode always uses the stub and sends nothing.

## Deploy it to your own Cloudflare account (about 15 minutes)

You need Node 20+, a Cloudflare account (free plan is enough) and, for production use, a Zero Trust organisation for Access. Everything runs in your account; nobody else holds your keys.

```sh
git clone <this repo> ops-desk && cd ops-desk
npm ci
npx wrangler login

# 1. Database
npx wrangler d1 create ops-desk-demo
#    copy the printed database_id into wrangler.jsonc → d1_databases[0].database_id
npx wrangler d1 migrations apply ops-desk-demo --remote

# 2. Pages project + deploy
npx wrangler pages project create ops-desk-demo --production-branch main
npx wrangler pages deploy public --project-name ops-desk-demo --branch main
```

That gives you the public demo. To run it as **your team's desk**:

1. In `wrangler.jsonc` set `"DEMO_MODE": "false"`, `ACCESS_TEAM_DOMAIN` (e.g. `https://yourteam.cloudflareaccess.com`), `ACCESS_AUD` (the application's AUD tag) and `ROLE_MAP`, e.g. `{"owner@yourshop.example":"owner","lee@yourshop.example":"manager","*@yourshop.example":"staff"}`.
2. Protect the site with Access: Zero Trust → Access controls → Applications → Create new application → Self-hosted and private, with an Allow policy for your team ([guide](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)). For the `*.pages.dev` hostname, follow [Enable Access on your pages.dev domain](https://developers.cloudflare.com/pages/platform/known-issues/).
3. Optional real alerts: set `"ALERT_ADAPTER": "webhook"` and `npx wrangler pages secret put ALERT_WEBHOOK_URL --project-name ops-desk-demo`, or `"telegram"` with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` ([Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)). Each alert row then records `sent` or `failed`.
4. Deploy again (`npx wrangler pages deploy public --project-name ops-desk-demo --branch main`). The wrangler file is the source of truth for the project's bindings and variables ([Pages configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)).

## Tests

```sh
npm ci
npx playwright install chromium   # skip if a Chromium build is already installed
npm test
```

`npm test` starts a clean local stack (`scripts/test-server.mjs`: fresh local D1, migrations applied, `wrangler pages dev` on 127.0.0.1:8799, all-visitor daily caps lifted because one run is hundreds of visitors) and runs 57 Playwright tests with one worker:

- **unit** (17): Access JWT verification (valid, wrong aud/iss, expired, not yet valid, `alg: none`, HS256, unknown key, tampered payload), role mapping, demo fallback, CSV cells, hash chain.
- **phone, 390 px** (11) and **desktop, 1440 px** (29): the full staff → manager → staff → owner flow through the UI; rejection needs a note; roles enforced by the API; two browser contexts cannot see each other's rows; forged cookies get a fresh sandbox; reset; CSV content and an independent re-computation of the audit hash chain from the CSV; append-only via API and via direct SQL against D1; 24 h purge; input caps, row caps and the per-network sandbox cap; the daily write budget (every write charged, writes and new sandboxes refused once it is spent, one network cannot spend it all, refused attempts write nothing); user text never rendered as HTML; axe-core WCAG 2.1 AA (including colour contrast) on every view in light and dark; keyboard skip link and focus; no horizontal scrolling; filter chips never clipped.

If the bundled Chromium will not start, point `FV_BROWSER` at another Chromium-based browser binary. `npm run typecheck` checks the Functions code; `npm run dev` runs the app locally on port 8788.

## Limits (Cloudflare free plan, checked 19 Nov 2026)

| Limit | Value | Source |
|---|---|---|
| Pages Functions requests | count toward the Workers free quota: 100,000/day, reset 00:00 UTC; static asset requests are free and unlimited | [Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker CPU time | 10 ms per HTTP request | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 rows | 5 million read/day, 100,000 written/day; over the limit, queries return errors until 00:00 UTC (no charge) | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| D1 size | 500 MB per database, 5 GB per account, 10 databases | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 queries per invocation | 50; a `batch()` counts as one | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 bound parameters | 100 per statement | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Pages files | 20,000 per site, 25 MiB per file | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) |
| `_headers` rules | 100 | [Pages limits](https://developers.cloudflare.com/pages/platform/limits/) |
| Cloudflare Access | Zero Trust Free: $0 for "teams under 50 users"; a user takes a seat on their first Access login | [Zero Trust plans](https://www.cloudflare.com/plans/sase-zero-trust/) (the developer docs do not state the seat count), [seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/) |

D1 counts `INSERT`, `UPDATE` and `DELETE` as writes and adds a row per index touched, and when the account hits the daily limit, queries fail until 00:00 UTC ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)). Measured with local D1 (`rows_written` in the structured logs `sandbox_created`, `write` and `sandboxes_purged`): seeding one sandbox writes 166 rows; purging an untouched one 24 h later writes about 70; a full request cycle with a 3-item checklist (file 14, approve 7, three ticks 3 each, done 10) writes 40. With the defaults, 100 sandboxes a day cost about 16,600 rows, which leaves about 8,000 of the 25,000-row demo budget for roughly 200 full cycles. Because the budget is checked before each write and the purge is counted but never refused, a day's demo total stays near 25,000 plus at most one day's purges (about 7,000): roughly a third of the account's quota, leaving the rest for your other apps. Lower `DEMO_ROWS_PER_DAY` if they need more.

The Workers request quota (100,000 a day, also per account) is not protected by the app: anyone can send that many requests to `/api/*`. Static files are free and unlimited, so the page itself still loads. If that matters, put the demo on a custom domain in your own zone and add the one rate-limiting rule the Free plan includes, on path `/api/` ([rate limiting rules](https://developers.cloudflare.com/waf/rate-limiting-rules/): set per zone; Free = 1 rule, 10 s period, Path and Verified Bot fields only).

Not included: file uploads for real proof photos (R2 needs a payment method on the account), scheduled overdue reminders (Pages Functions have no cron trigger; a separate Worker would), and email alerts.

## Layout

```
functions/api/[[path]].ts   the only Function: mounts src/router.ts on /api/*
src/                         router, identity + Access JWT, sandbox, desk logic, audit, alerts, CSV, validation, seed
migrations/                  D1 schema and triggers
public/                      index.html, app.js, app.css, _headers, font (OFL), sample photos
scripts/                     test server, sample-photo generator, screenshot helper
tests/unit, tests/e2e        Playwright
```

The sample photos are SVG illustrations generated by `scripts/make-photos.mjs`. The typeface is Atkinson Hyperlegible Next (SIL Open Font License, `public/fonts/OFL.txt`).

## Licence

MIT. See `LICENSE`.
