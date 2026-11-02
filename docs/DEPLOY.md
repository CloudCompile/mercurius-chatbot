# Deploy + runtime configuration

Reference for operators running `server.js` in production.
Maintained alongside the code — update this doc (and `.env.example`,
which is the canonical annotated list) whenever a new env var becomes
part of the supported runtime surface.

## Toolchain

| What | Value | Where it is pinned |
|---|---|---|
| Node | **22** (`22.x`) | `package.json` → `engines.node` (what Railway builds with, see below), `.nvmrc`, CI in `.github/workflows/server.yml` |
| npm | the one bundled with Node 22 | `package-lock.json` is lockfile v3 — always `npm ci`, never `npm install`, in CI and on Railway |

Local setup:

```
nvm use               # picks up .nvmrc → 22
npm ci
cp .env.example .env  # then fill in ANTHROPIC_API_KEY
npm test              # full suite; the count is whatever `# tests N` prints
npm run dev
```

Node 20 is no longer a supported target: it left Maintenance LTS in
April 2026 and CI tests against 22 only.

### How Railway picks the Node version

Railway builds with Nixpacks (`builder = "nixpacks"` in `railway.toml`).
Nixpacks resolves the Node version in this order, first match wins:

1. a `NODE_VERSION` (or `NIXPACKS_NODE_VERSION`) service variable,
2. `package.json` → `engines.node`,
3. `.nvmrc`, then `.node-version`.

So **`engines.node` wins over `.nvmrc`**, and a `.nvmrc` edit alone changes
nothing on Railway. Keep `engines` a pinned major (`"22.x"`): an open
range such as `">=22"` makes Nixpacks pick the newest major it ships
(24 in Nixpacks 1.41), a runtime no CI job tests. Keep the service
variables above unset so `engines` stays the single source of truth.

### Native modules must ship prebuilt binaries

The Nixpacks build image has **no python3 and no C/C++ compiler**. A
native dependency whose install falls back to `node-gyp` (no prebuilt
binary for linux-x64 + Node 22) fails `npm ci`, and the whole build dies
~15 s in, before any healthcheck. That is what blocked every deploy from
2026-09-24 (PR #21 added `engines ">=22"`; better-sqlite3 9.6.0 has no
Node 22/24 prebuild). better-sqlite3 is therefore on `^12.11.1`, which
ships linux-x64 prebuilds for Node 22 and 24. Do not move it to 13.x yet:
under npm 10 its install still runs `node-gyp` and fails the same way.
Production never loads better-sqlite3 (Postgres only), but `npm ci`
still installs it.

The GitHub runner that runs `npm test` HAS a compiler, so it cannot catch
this. The `postgres` job in `server.yml` runs `npm ci` inside
`node:22-bookworm-slim` (no python, no compiler) and fails if any native
module would have to build from source.

## Environment variables

`.env.example` carries one comment per variable and the value the code
falls back to when a variable is unset. This section is the operator
view: what to set in production and why.

### Required

| Var | Purpose | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Upstream key used by `@anthropic-ai/sdk` | Never log this. See `lib/logger.js` redact list. Not needed when `ANTHROPIC_MOCK=1`. |
| `ALLOWED_ORIGIN` | Comma-separated CORS allowlist | E.g. `https://mayoailiteracy.com,https://www.mayoailiteracy.com`. Unset means "any origin" — acceptable only in development. |
| `DATABASE_URL` | Postgres connection string | Railway-provided. Unset outside production = a local SQLite file (dev, tests). With `NODE_ENV=production`, or on any Railway service (`RAILWAY_ENVIRONMENT_NAME` is set), an empty value **refuses to boot** (`db.js` throws) instead of silently running on an ephemeral SQLite file; the failed healthcheck keeps the previous deployment live. `ALLOW_SQLITE_IN_PROD=1` is the deliberate escape hatch. |

### Recommended

| Var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP bind port | `3000` (Railway injects its own) |
| `NODE_ENV` | `production` switches log level to INFO and disables dev niceties | `development` |
| `ADMIN_PASSWORD` | Gates every `/api/admin/*` route via the `x-admin-password` header (events, kill switch) | Unset = admin endpoints always 401. Use a random 32+ char string. `ADMIN_AUTH_FAIL_ALERT_AT` (default `20`) wrong passwords within an hour, process-wide, page Discord (`admin_auth_fail`, at most hourly). |
| `USE_UNIFIED_PROMPT` | `1`/`true` serves every mode from the single unified system prompt (`lib/unifiedPrompt.js`) | Off. **Railway prod runs with it ON** — verify prompt work under both states. |
| `STREAK_TZ` | IANA zone that decides when a "day" rolls over: streaks, every daily quota below, and `DAILY_BUDGET_USD` all turn over at midnight here (`lib/productDay.js`). An unknown zone logs a warning and uses the default. | `America/New_York` |

### Anthropic + stream lifecycle + mock

The millisecond vars here treat empty or `0` as unset (the default
applies) — unlike the quotas below, where `0` means refuse.

| Var | Purpose | Default |
|---|---|---|
| `TUTOR_MODEL` | The tutor model: chat and lesson turns, the unit-test grader, fact-check, analyze and the cache prewarm. Each model's request fields (temperature, thinking, effort) come from `lib/modelParams.js`; unset sends exactly the `claude-sonnet-4-6` requests the server always sent. `claude-sonnet-5-5` is ready but gated on the A/B in `docs/sonnet-5-5/README.md`, which also has the switch and the rollback. Only these two are verified: any other id logs a boot warning (`TUTOR_MODEL is not claude-sonnet-4-6 or claude-sonnet-5-5`). After changing it, Redeploy; check `GET /api/health` → `model`. | unset = `claude-sonnet-4-6` |
| `TUTOR_EFFORT` | `output_config.effort` for the tutor-model calls other than a homework problem turn on a model that takes no temperature (`claude-sonnet-5-5`: every call but a problem turn, sent with `thinking: between_tools`). `low`, `medium` or `high`; anything else logs a boot warning and uses `low`. Ignored on `claude-sonnet-4-6`. | `low` |
| `MODEL_ALLOWLIST` | Comma-separated model ids the server accepts when a client supplies `model` on `/api/chat`; anything else is rejected with `invalid_model`. A set `TUTOR_MODEL` is always allowed too. | `claude-sonnet-4-6,claude-haiku-4-5` |
| `STREAM_IDLE_MS` | Abort a Claude stream that has produced no delta for this long (wedged upstream). Any upstream event counts, thinking deltas too; the SDK drops pings, which is why a Sonnet 5.5 problem turn asks for summarized thinking. | `30000` |
| `STREAM_MAX_MS` | Hard cap on one stream's total wall time (runaway reply). A healthy long lesson turn trips neither watchdog. | `150000` |
| `STREAM_WATCHDOG_MS` | Legacy name for `STREAM_MAX_MS` (eval/CI overrides); when set it wins | unset |
| `CLUB_FEED_TIMEOUT_MS` | Timeout for each fetch of the club site's `events-data.json` / `blog-content.json` (widget turns). A stale copy is served while one refresh runs; a failed fetch is retried after 5 min. `CLUB_EVENTS_URL` / `CLUB_BLOG_URL` override the feed URLs (tests) | `2000` |
| `SSE_KEEPALIVE_MS` | Interval between SSE `: ping` keepalive comments so school proxies and cellular NATs keep a quiet stream open | `15000` |
| `DRAIN_TIMEOUT_MS` | On SIGTERM stop accepting model work at once but let in-flight streams finish for up to this long before exiting | `30000` — Railway's kill window is `drainingSeconds = 35` in `railway.toml`; raise both together |
| `ANTHROPIC_MOCK` | Exactly `1` swaps the SDK for the in-process mock (`lib/anthropicMock.js`) — no key, no network, no spend. Integration tests and offline UI work; the server logs a boot warning. | off |
| `MOCK_SCENARIO` | `ok`, `error`, `overloaded`, `slow`, `hang` or `credit` — forces 5xx, 529, a stalled stream or credit exhaustion on demand | `ok`; only read when `ANTHROPIC_MOCK=1` |
| `MOCK_STREAM_DELAY_MS` | Delay between streamed text deltas from the mock (`slow` multiplies it by 20) | `5`; only read when `ANTHROPIC_MOCK=1` |
| `MOCK_TIMEOUT_MS` | How long a `hang` scenario waits before failing like the SDK client timeout | `30000`; only read when `ANTHROPIC_MOCK=1` |

### Observability

| Var | Purpose | Default |
|---|---|---|
| `LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, `silent` | `info` in prod, `debug` elsewhere, `silent` when `NODE_ENV=test` |
| `DISCORD_WEBHOOK_URL` | Channel webhook that receives operator alerts: spend cap at 80 %/100 %, kill-switch flips, per-IP cap trips, boot, Anthropic error bursts (`lib/alerts.js`) | Unset = alerts are a silent no-op. Treat as a secret — the URL embeds a token. |
| `IP_HASH_SALT` | Salt appended to the client IP before it is sha256-hashed for the `usage` ledger, per-IP alerts and logs (`lib/claudeCall.js` `hashIp`) | Empty = a salt generated once and stored in the `settings` table, i.e. in the same database as the hashes (the server logs a warning at boot in production). Set a long random string in production and keep it stable across deploys — rotating it breaks continuity of every hashed id in the ledger. Read once at boot. |

### Storage

| Var | Purpose | Default |
|---|---|---|
| `SQLITE_PATH` | SQLite file used only when `DATABASE_URL` is unset | `./mercurius.db` beside `db.js` |
| `IMAGE_STORAGE_DRIVER` | Where uploaded images are persisted | `db` (bytes in the database). Object-storage drivers plug in via `lib/imageStore.js`. |
| `PHOTO_REATTACH_TURNS` | How many follow-up user turns keep seeing a photo the student sent: the server re-attaches it to the turn it came with (`lib/photoReattach.js`, AUD-10), while it is under `IMAGE_RETENTION_HOURS` old (at most 24 h). Integer `0`–`20`; `0` turns re-attaching off (photos are still linked to their turn). Read once at boot. | `6` |
| `GAMIFICATION_ENABLED` | `1`/`true` activates the standby gamification tables and `/api/progression/*` | off; when off nothing gamification-related is created or served |

### Spend + safety rails

All of these are **in-memory, per process**. That is correct for the
single-replica deployment and adds no infrastructure; see "Scaling"
below before running more than one replica.

| Var | Purpose | Default |
|---|---|---|
| `DAILY_BUDGET_USD` | Global daily Anthropic spend ceiling in US dollars, priced per call from `lib/pricing.js`. Once reached, every Claude-backed route returns `503 spend_cap` (not retryable, with `retryAfterSec` and `Retry-After`) until midnight in `STREAK_TZ`. Re-hydrated from the usage table on restart, from that midnight. `0` refuses every call. Replaces the retired `DAILY_TOKEN_CEILING`, which is no longer read. | `15` |
| `CLAUDE_DISABLED` | `1`/`true` boots with all Anthropic calls disabled (503). The runtime toggle `POST /api/admin/kill-switch {"disabled":true\|false}` overrides it in seconds, no redeploy. | off |

### Per-minute rate limits (`lib/rateLimiter.js`)

Sized for a whole classroom behind one school NAT address, so a burst
of students never looks like one abusive client.

| Var | Scope | Default |
|---|---|---|
| `API_IP_PER_MIN` | all `/api/*` requests, per client IP | `400` |
| `CHAT_IP_PER_MIN` | `/api/chat`, per client IP (300 = a 30-student room at 5 turns each with 2× headroom; see docs/LOAD_REHEARSAL.md) | `300` |
| `UPLOAD_IP_PER_MIN` | `/api/images` uploads, per client IP (checked before the body is read) | `60` |
| `IMAGE_UPLOAD_INFLIGHT_BYTES` | image upload bodies being read at once, whole process (over it → `503 busy`) | `67108864` (64 MB) |
| `SESSION_DELETE_IP_PER_MIN` | `DELETE /api/session/:id` erasures, per client IP | `60` |
| `REPORT_IP_PER_MIN` | `/api/report` content reports, per client IP (a classroom behind one NAT; the client shows "reported" even on a 429) | `60` |
| `SESSION_PER_MIN` | `/api/chat` turns, per session id | `10` |

### Daily quotas + in-flight caps (`lib/quotas.js`)

Per-session and per-address backstops beneath `DAILY_BUDGET_USD`, so a
single runaway client cannot drain it for every other student. Counters
are per product day (midnight to midnight in `STREAK_TZ`, the same day as
the streaks and the budget) and in-memory. A tripped daily quota answers
`429 daily_limit` (with `retryAfterSec` = seconds to that midnight, so the
copy's "tomorrow" is true); a tripped in-flight cap answers `503 busy`
with a 60 s retry. Unset = default; `0` refuses everything.

Every refusal carries `scope` (`session`, `ip` or `global`, when it has
one), `retryAfterSec` (when there is a wait) and `retryable`, in the JSON
body and in the SSE `error` frame on `/api/chat`. `retryable` is false for
a student's own daily limit, `spend_cap` and `service_disabled`, and true
for a network's (`scope: ip`) daily limit, because cellular data is
another network. The network's messages say "Switch to cellular data, or
try again tomorrow." These fields are additive: older clients key off
`error`/`code` and ignore them.

**Day boundaries (AUD-30):** before this, the quotas and the budget
rolled at UTC midnight (7 PM CDT / 8 PM EDT). Now they roll at midnight
in `STREAK_TZ`. The Discord budget page says when ("refused until
midnight America/Chicago"). The digest and `/api/admin/stats` still bucket
by **UTC** day, so a digest's "yesterday's cost" (a UTC day) no longer
lines up exactly with one budget day.

Only a turn that got an answer uses a turn allowance (AUD-31). A call
that was refused, failed upstream, hit the server's own stream timeout,
or was stopped before any text arrived is still billed, so it counts
toward the dollar caps (`SESSION_DAILY_USD`, `IP_DAILY_USD`,
`DAILY_BUDGET_USD`), but not toward `SESSION_DAILY_LESSON_TURNS` or
`SESSION_DAILY_CHAT_TURNS`. The usage ledger's `answered` column (0/1)
records which is which, so the counts survive a restart.

A restart reads the rest of the day back from the same ledger too: a
session's dollars and photo uploads, and a network's dollars and photo
uploads (count and bytes). A stored photo is a `usage` row of kind
`image`, $0, with its size in `usage.bytes`. So a redeploy no longer
clears a network that has reached `IP_DAILY_USD`, `IP_DAILY_IMAGES` or
`IP_DAILY_IMAGE_BYTES`: raise the variable instead. A network's new sessions
and content reports are read back too (`IP_DAILY_NEW_SESSIONS`,
`IP_DAILY_REPORTS`): each is a $0 `usage` row of kind `session` or `report`
that carries only the network's hashed address (no session id, so erasing a
session leaves the network's count) and the day (its `ts` is the start of
the `STREAK_TZ` day, not the moment), and is deleted after
`NETWORK_COUNT_RETENTION_DAYS`. A session's own report count
(`SESSION_DAILY_REPORTS`) comes from the `reports` table.

**Known limit: an erasure, then a restart.** "Delete my data" erases the
session's `usage` rows, and those are the rows a restart reads a network's
dollars and photos back from. So after an erasure and then a deploy or a
crash restart the same day, the network gets back the share of
`IP_DAILY_USD`, `IP_DAILY_IMAGES` and `IP_DAILY_IMAGE_BYTES` that the
erased sessions used, and `DAILY_BUDGET_USD` gets back their dollars.
Until the restart nothing changes (the counts in memory stay). It is
bounded by the number of restarts and by `IP_DAILY_NEW_SESSIONS` (each
erased id was a sign-up). The new-session and report counts are not
affected. Closing it would mean keeping a per-network dollar and photo
total through an erasure, which is more kept about an erased student; that
is the founder's call, and it is not done.

| Var | Scope | Default |
|---|---|---|
| `SESSION_DAILY_LESSON_TURNS` | curriculum (lesson) turns per session | `40` |
| `SESSION_DAILY_CHAT_TURNS` | free-chat turns (incl. helper calls) per session | `60` |
| `SESSION_DAILY_USD` | Anthropic spend per session | `0.75` |
| `SESSION_DAILY_IMAGES` | image uploads per session | `20` |
| `SESSION_DAILY_REPORTS` | content reports per session (past it a report is acknowledged and dropped, like one for an unknown session) | `20` |
| `IP_DAILY_USD` | Anthropic spend per client IP, summed over its sessions | `10` |
| `IP_DAILY_NEW_SESSIONS` | new session ids per client IP (curbs id rotation) | `60` |
| `IP_DAILY_IMAGES` | image uploads per client IP per day, summed over sessions | `200` |
| `IP_DAILY_IMAGE_BYTES` | image bytes a client IP may store per day | `524288000` |
| `IP_MAX_INFLIGHT` | concurrent Claude calls per client IP | `40` |
| `MAX_INFLIGHT` | concurrent Claude calls for the whole process; beyond it requests get `503 busy`, not a queue | `80` |
| `HELPER_MODEL` | model for the summarizing helpers (quiz, report card, concept map, briefing); the tutor/grader/fact-check/analyze stay on the tutor model (`TUTOR_MODEL`) | `claude-haiku-4-5` |
| `EVAL_EXPOSE_USAGE` | eval servers only — puts settled usage on the SSE `complete` frame so `scripts/eval-pacing.mjs` can prove cache hits. Never set in production. | unset |
| `SCHEDULER_ENABLED` | in-process daily digest + retention sweep (`lib/scheduler.js`); `0` disables. Off under `NODE_ENV=test`. | `1` |
| `DIGEST_UTC_HOUR` | UTC hour after which the daily Discord digest posts once | `13` |
| `RETENTION_UTC_HOUR` | UTC hour after which the daily retention sweep runs once | `8` |
| `MESSAGE_RETENTION_DAYS` | chat/lesson transcripts older than this are deleted (`0`/`off` disables) | `90` |
| `IMAGE_RETENTION_HOURS` | uploaded image bytes older than this are deleted (the photo's own turn and up to `PHOTO_REATTACH_TURNS` follow-ups are the only consumers). The image purge also runs every 5 minutes, whatever the hour, and an older image is never served or attached | `24` |
| `REPORT_RETENTION_DAYS` | content reports older than this are deleted, open or resolved. A report quotes a student's turn verbatim, so it is not kept indefinitely; it outlives the 90-day transcript because it is the review record for a flagged reply | `180` |
| `USAGE_RETENTION_DAYS` / `LESSON_EVENTS_RETENTION_DAYS` | analytics rows (no content) older than this are deleted | `400` |
| `NETWORK_COUNT_RETENTION_DAYS` | a network's sign-up and report rows (`usage` kinds `session` / `report`: hashed address and day only) older than this are deleted. Only today's read-back after a restart needs them, and today's are never deleted, whatever the value | `2` |
| `SESSION_RETENTION_DAYS` | sessions inactive this long are erased via the deletion cascade, 200 per sweep | `365` |

### Removed variables

| Var | Status |
|---|---|
| `REDIS_URL` | Removed. Rate limits, quotas, the spend cap and the kill switch are all in-process; there is no Redis-backed store any more. Setting it does nothing. |
| `MEMORY_MODEL` | Removed with the background memory-extraction job. Setting it does nothing. |

Delete both from the Railway Variables tab so nobody reads them as
live configuration.

## Railway-specific deployment

`railway.toml` is the source of truth for the service definition:
nixpacks build, `node server.js` start command, health check on
`/api/health` with a 120 s first-response timeout (boot + Postgres
connect; the build is not on that clock), a 35 s drain window
(`drainingSeconds`), restart on failure up to 10 times, and
`watchPatterns`.

`watchPatterns` limits which merges deploy: only a change under
`server.js`, `db.js`, `lib/`, `prompts/`, `public/`, `migrations/`,
`scripts/`, `package*.json`, `railway.toml` or the Node/npm/Nixpacks
config files starts a production build. Docs-, iOS- and marketing-only
merges are skipped and do not restart the server. Two
consequences: a new runtime directory must be added to the list, and a
docs-only merge no longer retries a failed deploy — after changing
Railway variables, press **Redeploy** in the dashboard.

### Running one replica (current, default)

Set the env vars in the service's Variables tab:

```
ANTHROPIC_API_KEY=sk-ant-...
ALLOWED_ORIGIN=https://mayoailiteracy.com,https://www.mayoailiteracy.com
DATABASE_URL=<Railway-provided>
ADMIN_PASSWORD=<random 32 chars>
NODE_ENV=production
USE_UNIFIED_PROMPT=1
DAILY_BUDGET_USD=15
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
IP_HASH_SALT=<random 32 chars>
STREAK_TZ=America/New_York
```

Do **not** set `NODE_VERSION` or `NIXPACKS_NODE_VERSION`: they override
`engines.node` (see Toolchain).

The drain window is not a variable any more. `drainingSeconds = 35` in
`railway.toml` is how long Railway lets the old replica run after
SIGTERM before it SIGKILLs it: `DRAIN_TIMEOUT_MS / 1000` (30) plus 5 s,
so the server's own drain always finishes first. If
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` is still set on the service,
**delete it**: Railway does not document which of the two wins.

The per-minute limits and daily quotas can stay unset unless you are
tuning them; the defaults above apply.

### Database migrations

The base schema is code-owned (`db.initSchema`, `CREATE IF NOT EXISTS`
plus `ADD COLUMN IF NOT EXISTS` at every server boot, inside Railway's
network). **Nothing has to be run by hand for the current build:**

- `002_drop_student_memory` is now automatic. `initSchema` runs
  `DROP TABLE IF EXISTS student_memory` on every boot, so the first
  successful deploy removes the table (and a later boot removes it again
  if a rollback to a pre-removal build ever recreates it). The file stays
  for bookkeeping.
- `001_gamification` only creates the flag-gated gamification tables
  (`GAMIFICATION_ENABLED` creates them at boot anyway). Leave it until
  the flag is turned on.

Deltas that cannot live in `initSchema` ship as `migrations/NNN_name.sql`
and are applied with the `migrate` npm script (`scripts/migrate.mjs`):

```
SQLITE_PATH=./mercurius.db npm run migrate   # local SQLite (or: npm run migrate -- --sqlite)
DATABASE_URL=postgres://… npm run migrate    # a Postgres you can reach
```

`railway run npm run migrate` from a laptop does **not** work against
Railway Postgres: `DATABASE_URL` is the private
`postgres.railway.internal` host, which does not resolve outside
Railway (`getaddrinfo ENOTFOUND`). Use one of:

- `railway ssh -- npm run migrate` — runs inside the live service
  (needs a build that contains `scripts/migrate.mjs`, i.e. anything after
  2026-09-24 once it is deployed);
- from the repo checkout, with Public Access enabled on the Postgres
  service: `railway run --service Postgres sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npm run migrate'`
  (the single quotes matter: the variable belongs to the Postgres
  service and only exists inside that shell).

What the script does: prints its target (`migrate: target postgres @
host:port/db` or `sqlite <path>`; never the password) and refuses an
empty `DATABASE_URL` unless SQLite is explicit (`SQLITE_PATH` or
`--sqlite`), and SQLite outright under `NODE_ENV=production`; a mistyped
URL can no longer "succeed" against a throwaway local file. It
bootstraps the base schema only when the `sessions` table is genuinely
missing (a connection error is a failure, not "fresh database"), creates
`schema_migrations` if missing, then applies each not-yet-recorded file
in filename order — file and bookkeeping row in one atomic statement, so
a failure is neither half-applied nor recorded. Exit 0 when everything
is applied or already recorded, 1 otherwise. It is safe to re-run.
Migration files must not contain their own `BEGIN`/`COMMIT`.

`railway.toml` deliberately has no `preDeployCommand` yet: a failing
pre-deploy blocks the deploy with no retry, which is the wrong risk
while the first deploy since July is still pending. Prefer idempotent
DDL in `initSchema` for anything a build needs at boot.

### Scaling to N replicas

**Not supported by the current build.** Every safety rail — per-IP and
per-session rate limits, daily quotas, the USD spend cap and the kill
switch — is process-local state. With N replicas each of them silently
becomes `N × configured_limit` and the kill switch only flips the
replica that received the admin call. Before raising the replica count,
move that state to a shared store (the former Redis integration was
removed rather than left half-wired); until then keep the count at 1
and scale vertically.

## Health checks

| Route | Notes |
|---|---|
| `GET /api/health` | Returns `{ status, uptime, db, memory, commit, bootedAt }` (`commit` = the short SHA Railway built, `dev` locally). Railway's health check points here (`railway.toml`), and so does the `Prod health` GitHub Actions workflow (every 30 min; two failed probes open a `prod-down` issue). Returns 503 (not 200) when DB connectivity fails, so a deploy with a bad `DATABASE_URL` never takes traffic. |
| `GET /metrics` | Prometheus text exposition format. Admin-only (`x-admin-password`, like `/api/admin/*`): it exposes per-route cost and token counts. Answers 401 without the header. |

## Failure modes to know about

| Symptom | Likely cause | Action |
|---|---|---|
| **Build fails within seconds (~15 s), before any healthcheck**; the old deployment keeps serving (`/api/health` uptime keeps growing) | `npm ci` could not install a native module: no prebuilt binary for this Node ABI, and the Nixpacks image has no python3/g++ to compile it | Read the **build** log (not the deploy log) for `prebuild-install warn … No prebuilt binaries found` or `gyp ERR! find Python`, and check which Node version Nixpacks chose (`engines.node`; no `NODE_VERSION`/`NIXPACKS_NODE_VERSION` variable). Fix the dependency or the pin; CI's `postgres` job reproduces it. |
| Deploy stalls, then Railway marks it failed after ~2 min | `/api/health` never returned 2xx inside `healthcheckTimeout` — usually DB connectivity or a startup crash | Read the deploy log; check `DATABASE_URL`. `initSchema` creates or upgrades every table at boot, so a missing table points at a failed boot DDL (see "Startup crashes" below), not at a skipped migration |
| Boot fails at once with `… but DATABASE_URL is empty` | The service lost its `DATABASE_URL` (variable deleted or the Postgres reference renamed) | Re-add `DATABASE_URL=${{Postgres.DATABASE_URL}}` in Variables and redeploy. The guard is deliberate: it stops a silent run on ephemeral SQLite |
| `/api/health` returns 503 with `db: "error: ..."` | Postgres connection down / connection pool exhausted | Check `DATABASE_URL` validity; check Railway Postgres service health |
| Every Claude-backed route returns 503 and Discord got a `budget_100` alert | `DAILY_BUDGET_USD` reached | Decide whether the spend is legitimate. Raise the var (restart) or wait for midnight in `STREAK_TZ`. Look at `/api/admin/events` for who spent it. |
| Claude-backed routes return `503 restarting` for a few seconds | A deploy is draining the old replica (`DRAIN_TIMEOUT_MS`) | Expected; clients retry. If it outlasts the drain window the new replica failed its health check — read the deploy log. |
| Every Claude-backed route returns `503 service_disabled`, no budget alert | Kill switch is on — either `CLAUDE_DISABLED` at boot or a runtime flip | `GET /api/admin/kill-switch` to confirm; `POST /api/admin/kill-switch {"disabled":false}` to re-enable |
| Client sees `{"error":"rate_limited"}` en masse | Shared IP (school network, NAT) plus a burst of students over `API_IP_PER_MIN` / `CHAT_IP_PER_MIN` | Raise the relevant `*_PER_MIN` var for the event, then restore it. Per-session limits are unaffected. |
| One student gets `429 daily_limit` for the rest of the day | A `SESSION_DAILY_*` or `IP_DAILY_*` quota tripped (`lib/quotas.js`) | Confirm in the Discord `ip_cap` alert / admin events; raise the specific var if the usage was legitimate (restart to apply) |
| Clients get `503 busy` during a class | `IP_MAX_INFLIGHT` (whole school behind one NAT) or `MAX_INFLIGHT` reached | Transient by design — it clears as streams finish. Raise the cap only if `/metrics` shows the process was not actually saturated. |
| Client sees `{"error":"invalid_model"}` | Client is passing a `model` that isn't in `MODEL_ALLOWLIST` | Either remove the client's override or add the model to the env allowlist. |
| Startup crashes: `failed to initialize database` | Postgres schema creation (`initSchema`) failed. Check the deploy log for the underlying SQL error. | Reproduce with `node scripts/pg-smoke.mjs` against a scratch Postgres (CI's `postgres` job runs exactly this); fix the DDL in `db.js`. Do not hand-edit prod first. |
| Prompt content appears in Railway logs | Regression in `lib/logger.js` redact list | Open a red-PR issue — this is a correctness bug in the redaction layer. Review `tests/logger.test.js` for which paths are covered. |

## Post-deploy checklist

Run after any deploy that changes the server, and in full after the
first deploy since July (it turns on PRs #21–#31 at once).
`$HOST` is `https://mercurius-chatbot-production.up.railway.app`.

1. **Deployment succeeded.** Railway shows the deployment Active, or:
   `gh api repos/christensenshyam-hub/mercurius-chatbot/deployments --jq '.[0] | {id, sha}'`
   then `gh api repos/christensenshyam-hub/mercurius-chatbot/deployments/<id>/statuses --jq '.[0].state'`
   → `success`. In the build log, confirm Node **22** was used, no
   `gyp ERR!` appears, and no `NODE_VERSION` / `NIXPACKS_NODE_VERSION`
   variable is set on the service.
2. **The new process is serving.** `curl -s $HOST/api/health` →
   `"status":"ok"`, `"db":"connected"`, and `uptime` has **reset** to
   seconds or minutes (the July build reported millions of seconds).
3. **student_memory is gone.** In the Postgres service's Data tab (or
   any SQL console on it): `SELECT to_regclass('student_memory');` →
   `NULL`.
4. **/metrics is locked.** `curl -s -o /dev/null -w '%{http_code}\n' $HOST/metrics`
   → `401`.
5. **The erasure route is live.** `curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $HOST/api/session/abc`
   → `400` (a short id is refused). The July build answered `404`
   because the route did not exist. Deletion requests that arrive at
   privacy@ use this route too: `docs/PRIVACY_DELETION_RUNBOOK.md`.
6. **Drain window.** Delete `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` from
   Variables if it is set; `railway.toml` now sets `drainingSeconds`.
7. Set any still-pending variables from "Running one replica" above
   (`ADMIN_PASSWORD`, `DISCORD_WEBHOOK_URL`, `IP_HASH_SALT`,
   `DAILY_BUDGET_USD`, `STREAK_TZ`), then Redeploy once, and confirm
   the Discord `boot` alert arrives.

## Secrets hygiene

- All secrets flow through env vars, not files. Nothing in the repo.
- `ANTHROPIC_API_KEY`, `ADMIN_PASSWORD` are auto-redacted from logs
  at the pino serializer layer (see `lib/logger.js:REDACT_PATHS`).
- `DISCORD_WEBHOOK_URL` embeds a bearer-like token; `lib/alerts.js`
  never writes the URL or the alert body to the log — only the alert
  key, HTTP status and character count.
- `IP_HASH_SALT` is what keeps hashed IPs unlinkable to raw addresses;
  treat it like a password and do not reuse it across environments.
- When rotating the Anthropic key: deploy the new key to Railway
  first, wait for the new replica to come up, then revoke the old
  key at console.anthropic.com. Brief period where both work.
