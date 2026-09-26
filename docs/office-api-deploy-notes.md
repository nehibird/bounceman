# Bounce Man Office API — deploy notes for Dan

DRAFT for use only after Nehemiah's go-ahead at an exact SHA. This supersedes the deploy
notes drafted in Marcus Bennett's round-2 review (§10) — those predate the round-3 fixes
below (R2-C1/R2-H1/R2-M1..M4/R2-L1..L6). See `docs/office-api.md` for the full API design;
this file is the operational runbook.

## 1. Backup and rollback

- On the VPS, before deploying: `sqlite3 /opt/bounceman/data/bounceman.db ".backup '/opt/bounceman/backups/pre-office-api-$(date +%Y%m%d-%H%M%S).db'"`.
- Record the current running SHA for rollback. Rolling back means redeploying that SHA —
  every migration in this feature is additive (`db.js`'s `initialize()` only ever adds
  tables/columns with `CREATE TABLE IF NOT EXISTS` / a `PRAGMA table_info` guard before
  each `ALTER TABLE`), so old code ignores the new tables/columns cleanly and a rollback
  never needs a down-migration.
- Deploy only the approved SHA. Migrations run on boot and are additive/re-runnable.

## 2. Environment variables (names only)

| Var | Required | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | Prefer a restricted key: write access to Refunds and Checkout Sessions, read access to PaymentIntents/Charges/Balance/Payouts. |
| `STRIPE_EVENT_WEBHOOK_SECRET` | Yes | Refunds/payments are booked into the DB **only** by the webhook — bookkeeping silently stalls without this. |
| `BASE_URL` | Yes | Payment-link success/cancel redirect URLs. |
| `DB_PATH` | Yes | SQLite file path. |
| `SARAH_API_KEY` | Yes (for `/api/sarah`) | **Not** used by the office API (`/api/office/v1`) at all. |
| `OFFICE_DEFAULT_MAX_REFUND_CENTS` / `OFFICE_DEFAULT_DAILY_REFUND_CAP_CENTS` | No | Per-refund/daily defaults when a key's own cap column is `NULL`. Default $100 / $250. |
| `OFFICE_REFUND_HARD_MAX_CENTS` / `OFFICE_REFUND_HARD_DAILY_CAP_CENTS` | No | Hard ceilings — no key, however configured, can exceed these. Default $500 / $1,000. **Deploy-config, not a code constant** (R2-I1) — treat a change to these as a policy change, not a code change. |
| `OFFICE_MANUAL_PAYMENT_HARD_MAX_CENTS` | No (new, R2-L3) | Manual (cash/check/etc) payment ceiling, independent of the refund ceilings above. Default $10,000. |

No new *required* env vars this round — `OFFICE_MANUAL_PAYMENT_HARD_MAX_CENTS` is optional
and defaults to today's effective value ($10,000).

## 3. Stripe webhook configuration

`https://bouncemanrentals.com/api/webhooks/stripe` must subscribe to:
- `checkout.session.completed` — records payments (deposits and office payment-links).
- `charge.refunded` — the only place `payments.refund_amount`/`bookings.total` are reduced.
  **R4-L1:** a webhook body is frozen at generation time — a late/retried delivery can
  still carry a since-canceled refund in its cumulative `amount_refunded`. The handler
  recomputes the cumulative figure itself rather than trusting that field at face value:
  - If the payload carries a COMPLETE `charge.refunds.data` list (not paginated), it sums
    the non-failed/non-canceled entries, cross-checked against what our own
    `office_refunds` ledger has since learned about each refund id.
  - Otherwise (the common case in production — `Charge.refunds` is **not guaranteed
    present** on a Charge object; see the R4-L1-gap commit for the stripe-node evidence),
    it fetches the LIVE `amount_refunded` from Stripe directly instead.
  - **If that live fetch itself fails, the webhook responds `503` and does NOT mark the
    event processed** — Stripe redelivers automatically (retries for up to 3 days). This
    is expected, not an outage to page on by itself; only alert if it persists across
    multiple redeliveries (see §11).
- `charge.refund.updated` — marks an `office_refunds` ledger row `failed` if Stripe itself
  later fails/cancels a refund, **and (R3-L3) also corrects `payments.refund_amount` by
  fetching the charge's CURRENT live `amount_refunded` and SETTING it to that absolute
  figure (not "adding back" the refund's own amount — a plain add/subtract on top of a
  possibly-stale prior value can under/overcorrect on out-of-order delivery), then
  recomputes `bookings.total` from that.** This event was already required before round 3;
  nothing new to subscribe to, but its handler now does more.

Confirm recent deliveries return 2xx in the Stripe dashboard before and after cutover.

## 4. Proxy / network exposure (R2-M4, R3-I1)

**Do not assume any of this is already done — Dan's own checklist (audited during round 3)
still listed `0.0.0.0:3202` as an open gap despite an earlier note claiming it was bound to
loopback. Every item below is a MANDATORY verification step at THIS deploy, not a
confirmation of prior work.**

- **Port binding — verify with the command, not by asking:**
  ```bash
  ss -ltnp | grep 3202
  # MUST show: LISTEN 0 ... 127.0.0.1:3202 ...   (NOT 0.0.0.0:3202 or :::3202)
  ```
  Matches the repo's `docker-compose.yml` (`127.0.0.1:3202:3200`, loopback only).
- **Confirm from OUTSIDE the box that the port is unreachable directly** (bypassing nginx
  entirely would mean anyone on the internet can hit the app without going through
  Cloudflare or nginx's IP restoration):
  ```bash
  curl -m 5 http://<vps-public-ip>:3202/
  # MUST fail (connection refused/timeout) — if this returns anything, STOP, the port is
  # exposed and this deploy cannot proceed until it's fixed.
  ```
- **Verify nginx actually restores the real visitor IP along the full path** (Cloudflare →
  nginx → this app) — this is the one Marcus's round-3 review flagged as the thing that
  actually matters (not whether nginx "overwrites" XFF in the abstract): check the
  `bounceman.conf` (or wherever this app's server block lives) has **BOTH Cloudflare IP
  lists** as `set_real_ip_from` lines (not just v4 — Cloudflare edges connect over IPv6
  too, and a missing v6 list means a v6-originated request's `req.ip` still resolves to the
  Cloudflare edge, silently only half-fixing this) **and** `real_ip_header`. The ranges
  below are recorded from this review's own reference material, not fetched live at deploy
  time — **before using them, diff against the live lists at
  <https://www.cloudflare.com/ips-v4> and <https://www.cloudflare.com/ips-v6>; trust
  Cloudflare's current published ranges over this document if they ever disagree:**
  ```nginx
  # https://www.cloudflare.com/ips-v4  (fetch fresh — do not hand-copy a stale list)
  set_real_ip_from 173.245.48.0/20;
  set_real_ip_from 103.21.244.0/22;
  set_real_ip_from 103.22.200.0/22;
  set_real_ip_from 103.31.4.0/22;
  set_real_ip_from 141.101.64.0/18;
  set_real_ip_from 108.162.192.0/18;
  set_real_ip_from 190.93.240.0/20;
  set_real_ip_from 188.114.96.0/20;
  set_real_ip_from 197.234.240.0/22;
  set_real_ip_from 198.41.128.0/17;
  set_real_ip_from 162.158.0.0/15;
  set_real_ip_from 104.16.0.0/13;
  set_real_ip_from 104.24.0.0/14;
  set_real_ip_from 172.64.0.0/13;
  set_real_ip_from 131.0.72.0/22;
  # https://www.cloudflare.com/ips-v6
  set_real_ip_from 2400:cb00::/32;
  set_real_ip_from 2606:4700::/32;
  set_real_ip_from 2803:f800::/32;
  set_real_ip_from 2405:b500::/32;
  set_real_ip_from 2405:8100::/32;
  set_real_ip_from 2a06:98c0::/29;
  set_real_ip_from 2c0f:f248::/32;
  real_ip_header CF-Connecting-IP;
  ```
  **Refresh these periodically** — Cloudflare adds/retires ranges occasionally (rare, but it
  happens): re-fetch both lists at least monthly, or immediately if Cloudflare announces a
  range change, diff against what's in `bounceman.conf`, update, then `nginx -t && nginx -s
  reload` (never a full restart — this must not drop in-flight connections). A stale list
  isn't a hard failure (Cloudflare's OLD ranges don't just vanish overnight), but a truly
  NEW Cloudflare edge range would fall through unmatched and `req.ip` would resolve to that
  edge instead of the visitor.
  Without both directives — for BOTH address families — `req.ip` inside the app resolves to
  a **Cloudflare edge IP**, not the visitor's — which means the per-IP failed-auth limiter
  (`middleware/office-auth.js`) keys on shared Cloudflare edges instead of real clients.
  (Sarah's own valid key is never blocked either way — only failed-auth attempts count
  against the limiter — but this still matters for anyone else's traffic hitting bad
  actors sharing an edge IP with Sarah's egress path.)
- **Confirm the app's own server block actually forwards a real `X-Forwarded-For` header to
  Node** — `set_real_ip_from`/`real_ip_header` only fix what NGINX itself believes
  `$remote_addr` is; `trust proxy 1` in `server.js` reads `X-Forwarded-For` from the request
  nginx sends to the app, which nginx only populates correctly if the server block (or a
  shared `proxy.conf`/snippet it includes) has:
  ```nginx
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  # ($remote_addr alone is also acceptable for a single-hop proxy, but
  # $proxy_add_x_forwarded_for is the standard/safer choice — it appends rather than
  # clobbers, so it degrades gracefully if a hop is ever added later.)
  ```
  Grep for it directly rather than assuming a shared snippet has it:
  ```bash
  grep -RIn 'proxy_set_header X-Forwarded-For' /etc/nginx/sites-enabled/ /etc/nginx/snippets/ 2>/dev/null
  ```
  Missing this line means `req.ip` inside the app falls back to nginx's own address (or
  whatever the bridge network's peer address is) no matter how correct
  `set_real_ip_from`/`real_ip_header` are — the two checks above fix `$remote_addr` INSIDE
  nginx; this one is what actually gets that corrected value to Node.
- **`server.js`'s `trust proxy` setting stays at `1` — never change it, in either
  direction:**
  - **Never `'loopback'`** — Docker's bridge networking means a connection arriving via
    the published port has a peer address of the docker bridge gateway, not `127.0.0.1`,
    so `'loopback'` would silently stop trusting `X-Forwarded-For` at all.
  - **Never `2`** — with exactly one nginx hop between Cloudflare and this app, `trust
    proxy: 2` would trust a SECOND hop of `X-Forwarded-For` that doesn't exist here, which
    is spoofable by anyone sending a request directly to nginx with a crafted XFF header
    (bypassing the real-IP restoration above entirely). `1` is correct for exactly one
    trusted proxy hop (nginx) and must not be "fixed" to 2 even if IP attribution looks
    wrong after this deploy — re-check the `set_real_ip_from`/`real_ip_header` config
    above first.
- This is a confirmation-and-verification step at every deploy, not a one-time setup task
  — re-run all three checks above even if a prior deploy already passed them.

## 5. Reconcile — schedule it (R2-M2d, R3-M2: MANDATORY money-safety control)

**Not yet scheduled in production. This is a hard prerequisite, not housekeeping:
INSTALL AND CONFIRM THIS CRON IS RUNNING BEFORE any key is granted `refunds:create` for
real — do not provision Sarah's key (§7) until this section is done and verified.**
Stripe forgets an idempotency key after ~24h; the app's own same-key resume now confirms
via `findRefundByOfficeId` before ever retrying `refunds.create`, but a reservation that
Stripe has no answer for AND that has aged past ~23h is refused (`needs_review`, `409
refund_needs_reconcile`) rather than guessed at — reconcile (or a human via the resolve
CLI) is the only thing that clears it.

**R4-L5: the crontab below is complete and concrete, not a fill-in-the-blank sketch** — a
bare `$SLACK_ALERT_WEBHOOK_URL` reference in a crontab silently expands to empty (cron's
own environment is minimal; it does NOT source `.bashrc`/`.profile`/the shell's login env),
so the earlier draft's alert would have failed with no error the first time it fired. The
webhook URL is sourced from a dedicated, root-only env file instead:

`/opt/bounceman/.env.reconcile-alert` (create this file — `chown root:root`, `chmod 600`):
```
SLACK_ALERT_WEBHOOK_URL=https://hooks.slack.com/services/REPLACE/WITH/REAL_WEBHOOK
```

`/etc/cron.d/bounceman-reconcile` (system crontab — needs the `root` user field that a
per-user `crontab -e` file does NOT; also `chown root:root`, `chmod 600`):
```cron
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Reconcile every 10 minutes (5–10 min is the target cadence; anything tighter is wasted
# Stripe API calls, anything looser leaves an ambiguous refund uncounted-toward-caps for
# longer than necessary). Exits non-zero whenever any row ends the run needs_review.
*/10 * * * * root cd /opt/bounceman && . /opt/bounceman/.env.reconcile-alert && docker compose exec -T web node scripts/reconcile-office-refunds.js --older-than-minutes 15 >> /var/log/bounceman-reconcile.log 2>&1 || (. /opt/bounceman/.env.reconcile-alert && curl -fsS -X POST -H 'Content-type: application/json' --data '{"text":"⚠️ office-refund reconcile exited non-zero — check /var/log/bounceman-reconcile.log and office_refunds.status = '"'"'needs_review'"'"'"}' "$SLACK_ALERT_WEBHOOK_URL")

# Staleness check every 15 minutes — a crashed container or a cron that stopped firing
# entirely exits zero times, never non-zero, so the exit-code alert above can never catch
# it on its own. This is the concrete "alert if stale" check the earlier draft only
# described in prose.
#
# R5-L5: `find LOG -mmin +60 | grep -q .` prints NOTHING when LOG doesn't exist at all —
# so a cron that never fired even once (exactly the failure this check exists to catch)
# never alerts. `[ ! -e LOG ]` short-circuits the OR so a missing log alerts too.
*/15 * * * * root . /opt/bounceman/.env.reconcile-alert && { [ ! -e /var/log/bounceman-reconcile.log ] || find /var/log/bounceman-reconcile.log -mmin +60 | grep -q .; } && curl -fsS -X POST -H 'Content-type: application/json' --data '{"text":"🚨 bounceman-reconcile.log has not been updated in over 60 minutes (or does not exist) — the reconcile cron may not be firing at all"}' "$SLACK_ALERT_WEBHOOK_URL"
```

- **The file above must end with a trailing newline** — `/etc/cron.d` files (and any
  run-parts-style crontab) silently ignore a last line with no newline after it, so an
  editor that strips trailing newlines on save can quietly disable the staleness check (or
  the reconcile job itself, if it's the last line) with no error anywhere.
- **This staleness alert repeats every 15 minutes for as long as the log stays stale** —
  it's not a one-shot; expect (and don't be alarmed by) a repeat page every cycle until the
  underlying cron/container issue is fixed.
- **Logrotate** the reconcile log so it doesn't grow unbounded — `/etc/logrotate.d/bounceman-reconcile`:
  ```
  /var/log/bounceman-reconcile.log {
    weekly
    rotate 12
    compress
    missingok
    notifempty
    copytruncate
  }
  ```
  `copytruncate` matters here: the reconcile cron line above opens the log with a plain
  shell redirect (`>>`) each run rather than holding it open, but using `copytruncate`
  (truncate-in-place) rather than the default rename+recreate means no window where the
  log briefly doesn't exist and a staleness check happens to run right then.
- **Optional (I3):** the cron line's `curl -d '...'` puts the Slack webhook URL on the
  command line for the moment it runs, which other users on the box could see via `ps`.
  Acceptable on this single-tenant VPS; if you want to avoid it anyway, write the payload
  to a small `-K` config file instead: `curl -fsS -K /opt/bounceman/reconcile-alert.curlrc`
  with the URL and `--data`/`-H` lines inside that file (root-only, `chmod 600`).

- Confirm the schedule is actually loaded: `crontab -l` won't show `/etc/cron.d/*` files —
  check with `cat /etc/cron.d/bounceman-reconcile` and `systemctl status cron` (or `crond`),
  and watch `/var/log/bounceman-reconcile.log` actually grow over the next 10–20 minutes
  after deploy.
- Swap the `curl`/Slack webhook shape above for whatever this deploy's actual alerting
  channel is (PagerDuty, `mail`, a local notify script with an absolute path, etc.) if it
  isn't Slack — the pattern (source the secret from a root-only file, never a bare env var
  reference) is what matters, not the specific webhook.
- Sweeps `pending`, `needs_review`, and (R2-C1) legacy ambiguous-`failed` rows (an error
  was recorded but never classified `definitive`) — never calls `stripe.refunds.create`,
  only looks refunds up by `metadata.office_refund_id`. **R3-L1:** finalizing a row
  `failed` here also retires its idempotency key, so a same-key retry afterward starts
  fresh instead of a permanent `409`. **R3-L4:** hitting `findRefundByOfficeId`'s page cap
  is reported as a lookup failure (`needs_review` with the cap error recorded), not
  silently treated as "not found".

## 6. Clearing a stuck `needs_review` row (R2-M2a)

If reconcile can't resolve a row automatically (Stripe genuinely has no matching refund,
or the lookup itself keeps failing), a human confirms the real answer on the Stripe
dashboard and records it with the audited CLI — **never by hand-editing the DB row**:

```bash
# Stripe confirms the refund actually went through:
docker compose exec -T web node scripts/resolve-office-refund.js <ledger_id> succeeded \
  --reason "confirmed on Stripe dashboard, re_xxx matches" --stripe-refund re_xxx --actor "Dan"

# Stripe confirms it never happened / was never charged:
docker compose exec -T web node scripts/resolve-office-refund.js <ledger_id> failed \
  --reason "confirmed never charged" --actor "Dan"
```

- `--reason` and `--actor` are both required (exits non-zero, no change, without either —
  R3-M1 removed the old `unknown-operator` default for `--actor`).
- Marking `succeeded` requires `--stripe-refund re_...` and is verified against Stripe
  automatically as long as `STRIPE_SECRET_KEY` is set in that shell — it will be, inside
  the container. **`succeeded` needs the retrieved refund's own Stripe status to be
  `succeeded`** (R5-M1) — a live `failed`/`canceled` refund is refused with a message to
  resolve the row as `failed` instead; a live `pending`/`requires_action` refund is refused
  as "not final yet, leave it to reconcile". It also requires `metadata.office_refund_id`
  to match, the amount to match, and the currency to be `usd`. **A 404 ("no such refund",
  e.g. a typo'd id) is likewise refused** (R5-M2) — Stripe positively saying the id doesn't
  exist is a finding, not an outage. **R3-M1: marking `failed` now requires the same kind
  of verification** — it refuses (no change) if Stripe shows a non-failed/non-canceled
  refund already exists for the row, or if the lookup itself fails; a confirmed-`failed`
  row also retires its idempotency key so a same-key retry can reserve fresh.
  **`--no-verify` can NEVER override any live Stripe ANSWER** (R4-M1, extended by R5-M1/
  R5-M2): a confirmed live refund (for `failed`), a non-`succeeded` status, a 404, or a
  metadata/amount/currency mismatch (for `succeeded`) always refuses, with or without
  `--no-verify`. That flag only excuses the Stripe CALL itself failing — unreachable,
  timed out, a 5xx/429, or no/bad `STRIPE_SECRET_KEY`. If `failed` refuses because a refund
  already exists, run `succeeded --stripe-refund <that re_ id>` instead — the tool prints
  this suggestion itself. **R4-L4:** if the payment row has no Stripe `pi_`/`ch_` id at
  all, there is nothing to check — this requires `--no-verify` and is recorded honestly as
  `no_stripe_target`, never as a completed "none found" check. `--stripe-refund`, when
  given, must look like `re_...` even with `--no-verify`. `--no-verify` is an escape hatch
  for the Stripe call being genuinely unavailable; avoid it unless you've checked the
  dashboard yourself.
- Only acts on `needs_review` rows, or `pending` rows older than `--older-than-minutes`
  (default 15) — refuses a fresh/still-in-progress row.
- Writes an audit row (`api_audit_log` + `activity_log`) naming the actor and reason, in
  the same transaction as the status change.
- `SELECT * FROM office_refunds WHERE status = 'needs_review'` is the query to check
  outstanding count before/after a deploy or an incident.

## 7. Sarah's key

**Do not run this section until §5's reconcile cron is installed and confirmed running.**
Granting `refunds:create` before reconcile is scheduled means an ambiguous refund past the
~23h resume window has nothing to clear it — see R3-M2.

```bash
<secret-source> | docker compose exec -T web node scripts/api-key.js create sarah-office-2026-10 \
  --scopes bookings:read,bookings:write,availability:read,availability:write,customers:read,customers:write,payments:read,payments:record,payments:link,refunds:create,reports:read,audit:read \
  --max-refund-cents <N> --daily-cap-cents <M>
```

- `refunds:create` must be granted explicitly — a bare `--scopes '*'` never grants it.
- **New this round (R2-L1):** `create`/`limits` now *refuse* a cap above the hard ceiling
  outright (exit non-zero, nothing stored) instead of silently storing an over-ceiling
  value — if this command errors, the `--max-refund-cents`/`--daily-cap-cents` value you
  gave is above the current `OFFICE_REFUND_HARD_MAX_CENTS`/`_DAILY_CAP_CENTS`; lower it or
  raise the ceiling deliberately first.
- Verify with `api-key.js list` (now shows **both** the stored value and the effective
  dollar value, e.g. `max_refund_cents=999999 (effective $500.00, clamped)`), and confirm
  via `GET /whoami` with the real key.
- Values for `<N>`/`<M>` need Nehemiah's confirmation before this key is provisioned for
  real (open product question from the original review, still open).

## 8. Rotation

Unchanged from round 2: create `sarah-office-<next>` with the same scopes/caps, update
Sarah's secret store, confirm `/whoami` shows the new name, then
`api-key.js revoke sarah-office-2026-10`. On suspected compromise, revoke first, then
review `api_audit_log`/`office_refunds` for the old key's `key_name`.

## 9. Post-deploy checks, zero-risk first

1. `GET /whoami`: no key → 401; Sarah's key → 200 with the right scopes and **effective**
   caps.
2. `GET /bookings?limit=1` and `GET /availability` → 200.
3. `dry_run:true` on `POST /refunds` and `POST /payment-link` against a real booking —
   check the amounts, `refundable_cents`, the caps, and `live_charge_checked: true`. No
   Stripe money moves. **New this round:** if Stripe itself is unreachable, `dry_run`
   should now return `503 {error:"live_check_unavailable"}` rather than a fabricated
   preview — that's R2-H1's fail-closed behavior working as intended, not a bug.
4. **R4-L5:** run manually once via the SAME path the cron uses — a bare `node
   scripts/reconcile-office-refunds.js` runs outside the container, against whatever `DB_PATH`
   the shell's own environment happens to have (the wrong database, or none at all), not the
   app's real one:
   ```bash
   cd /opt/bounceman && docker compose exec -T web node scripts/reconcile-office-refunds.js --older-than-minutes 15
   ```
   Confirm it reports "No pending office refunds..." (nothing stuck from before deploy).
5. Confirm the cron entry from §5 is actually installed and firing
   (`grep reconcile /etc/cron.d/* 2>/dev/null` or the container's crontab, depending on
   where it's scheduled) — this has never been scheduled in production before.

## 10. Live $1 test — only with Nehemiah's explicit OK

Unchanged from the original draft:
1. Create a 100-cent link on an internal test booking and have Nehemiah pay it.
2. Confirm the webhook recorded it.
3. Refund 100¢ through the API.
4. Check: the Stripe Dashboard refund, `charge.refunded` 2xx, `payments.refund_amount`,
   the booking total, an `office_refunds` row `succeeded`, and an `api_audit_log` row.

Better still, do all of this first on a staging instance with test-mode keys.

## 11. What to watch

New/changed log lines this round, in addition to the round-2 set
(`[OFFICE API] Stripe refund failed`, `[OFFICE-AUTH] audit write failed`,
`[Stripe Webhook Error]`, 429s):
- `[OFFICE API] Stripe refund outcome UNKNOWN (ambiguous error, reservation kept)` — an
  ambiguous Stripe error (timeout/connection/5xx). Expected occasionally; Sarah's caller
  should retry with the same Idempotency-Key. If this spikes, Stripe (or this box's
  network path to it) is having a bad day.
- `[OFFICE API] live charge lookup unverified — failing closed, no reservation, no Stripe
  refund call` — R2-H1's fail-closed path firing. A spike means the live-check Stripe call
  is failing/timing out a lot; refunds will 503 until it clears.
- `[Stripe Webhook] charge.refund.updated: refund_amount set to $X.XX (delta $X.XX) on
  payment ...` (this is the exact current string — an earlier draft of this doc quoted
  "reversed $X.XX", which the code has never logged) — R2-L5/R3-L3's reversal-correction
  path firing. Rare; worth a manual look at the booking each time it fires, just to confirm
  the correction matches reality.
- `[Stripe Webhook] charge.refunded: refunds list incomplete/absent on the payload AND the
  live amount_refunded lookup failed — refusing to trust the frozen total, Stripe will
  redeliver` (R4-L1) — the webhook responded `503` for this delivery; Stripe will retry
  automatically. A single occurrence is not alarming. **Alert if this repeats for the same
  charge across multiple redeliveries** (check the raw Stripe event log for that charge) —
  that means the live Stripe API call itself is failing repeatedly, not just once.
- `N row(s) need manual review` from the reconcile cron (§5) — should be rare; each one
  needs the resolve CLI (§6) to clear.
- `[OFFICE API] Stripe refund error looked definitive, but a matching refund DOES exist at
  Stripe — finalizing from it, never releasing the reservation` (R3-C1(b)) — this is the
  hidden-retry gap actually firing and being caught correctly. Should be rare; if it spikes,
  something is causing frequent connection resets between this box and Stripe.
- `[OFFICE API] resume: reservation is older than the safe same-key resume window` (R3-M2)
  — should never happen if the reconcile cron (§5) is running on schedule; if it does,
  check why reconcile hasn't cleared this row in ~23h.
- `unresolved_refund` 409 responses (R3-M3) — expected occasionally if a caller
  (mis)retries with a new key while a previous attempt is still unresolved; a sustained
  stream of them on one payment points at a caller that isn't following the
  same-key-retry rule.

## Sarah / API contract changes to relay

See `docs/office-api.md` §3/§5/§6 for full detail; the short version for whoever owns
Sarah's integration:

1. A refund's `502`/`504` response may include `outcome:"unknown"` — on that, **always
   retry with the same `Idempotency-Key` and body, never a new key**.
2. `POST /bookings/:n/refunds` can now return `503 {error:"live_check_unavailable"}`
   (including on `dry_run`) — transient, retry later, no reservation was made.
3. `live_charge_checked` is now always `true` on any non-503 refund response.
4. Payment-link requests are now reserved before Stripe is called — a genuinely
   concurrent duplicate gets `409` instead of a stray second Checkout Session.
5. **(R3-M3) New:** a refund request with a NEW `Idempotency-Key` on a payment that
   already has an unresolved refund now gets `409 {error:"unresolved_refund", ledger_id,
   retry_with_same_idempotency_key:true}` — retry the NAMED `ledger_id`'s own key, or wait.
   This can happen even when there's plenty of room left under the caps.
6. **(R3-M2) New:** a same-key retry can get `409 {error:"refund_needs_reconcile",
   ledger_id}` if the reservation is old enough that Stripe may have forgotten the
   idempotency key and Stripe has no record of it either — wait for the reconcile cron or
   ping ops to run `scripts/resolve-office-refund.js`. This should be rare (requires no
   retry at all for ~23h) and points at a missed/late reconcile run if it happens often.
