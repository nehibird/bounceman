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
- `charge.refund.updated` — marks an `office_refunds` ledger row `failed` if Stripe itself
  later fails/cancels a refund, **and now also corrects `payments.refund_amount`/
  `bookings.total` back up by that refund's own amount if it had already been counted as
  succeeded (R2-L5)**. This event was already required before round 3; nothing new to
  subscribe to, but its handler now does more.

Confirm recent deliveries return 2xx in the Stripe dashboard before and after cutover.

## 4. Proxy / network exposure (R2-M4)

- **Dan has already bound the prod port to loopback today** (`127.0.0.1:3202`) — this
  deploy just needs to **confirm** that binding is still in place and matches what the
  repo's `docker-compose.yml` now declares (`127.0.0.1:3202:3200`, was `3202:3200` on all
  interfaces):
  ```bash
  ss -ltnp | grep 3202
  # expect: LISTEN 0 ... 127.0.0.1:3202 ...   (NOT 0.0.0.0:3202 or :::3202)
  ```
- Confirm nginx overwrites `X-Forwarded-For` before proxying to this container (it must
  never pass through a client-supplied XFF value unmodified).
- **`server.js`'s `trust proxy` setting is deliberately left at `1`, not `'loopback'`** —
  see the comment at that line. Docker's bridge networking means a connection arriving via
  the published port has a peer address of the docker bridge gateway, not `127.0.0.1`, so
  `'loopback'` would silently stop trusting `X-Forwarded-For` at all. Do not "fix" this
  without re-reading that comment first.
- No action needed if `ss` already shows loopback-only and nginx already strips
  client-supplied XFF (per Dan) — this is a confirmation step, not a new change to make.

## 5. Reconcile — schedule it (R2-M2d, R3-M2: now a REQUIRED money-safety control)

**Not yet scheduled in production, and R3-M2 makes this a hard prerequisite, not
housekeeping: install this cron BEFORE any key is granted `refunds:create` for real.**
Stripe forgets an idempotency key after ~24h; the app's own same-key resume now confirms
via `findRefundByOfficeId` before ever retrying `refunds.create`, but a reservation that
Stripe has no answer for AND that has aged past ~23h is refused (`needs_review`, `409
refund_needs_reconcile`) rather than guessed at — reconcile (or a human via the resolve
CLI) is the only thing that clears it.

```cron
*/10 * * * * cd /opt/bounceman && docker compose exec -T web node scripts/reconcile-office-refunds.js --older-than-minutes 15 >> /var/log/bounceman-reconcile.log 2>&1 || curl -fsS -X POST -H 'Content-type: application/json' --data '{"text":"⚠️ office-refund reconcile exited non-zero — check /var/log/bounceman-reconcile.log and office_refunds.status = '"'"'needs_review'"'"'"}' "$SLACK_ALERT_WEBHOOK_URL"
```

- Runs every 10 minutes (5–10 min is the target cadence; anything tighter is wasted Stripe
  API calls, anything looser leaves an ambiguous refund uncounted-toward-caps for longer
  than necessary).
- The script exits non-zero whenever any row ends the run `needs_review` — the `||
  <alert>` above is a minimal example; wire it to whatever this deploy's actual alerting
  channel is (Slack webhook, PagerDuty, etc.) instead of the inline `curl` shown. **Also
  alert if the log file itself hasn't been updated in over an hour** — a non-firing cron
  (crashed container, misconfigured schedule) exits zero times, never non-zero, so
  exit-code alerting alone can't catch it.
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
  automatically (refund exists, `metadata.office_refund_id` matches, amount matches) as
  long as `STRIPE_SECRET_KEY` is set in that shell — it will be, inside the container.
  **R3-M1: marking `failed` now requires the same kind of verification** — it refuses (no
  change) if Stripe shows a non-failed/non-canceled refund already exists for the row, or
  if the lookup itself fails; a confirmed-`failed` row also retires its idempotency key so
  a same-key retry can reserve fresh. `--stripe-refund`, when given, must look like
  `re_...` even with `--no-verify`. `--no-verify` is an escape hatch for genuinely stuck
  cases; avoid it unless you've checked the dashboard yourself.
- Only acts on `needs_review` rows, or `pending` rows older than `--older-than-minutes`
  (default 15) — refuses a fresh/still-in-progress row.
- Writes an audit row (`api_audit_log` + `activity_log`) naming the actor and reason, in
  the same transaction as the status change.
- `SELECT * FROM office_refunds WHERE status = 'needs_review'` is the query to check
  outstanding count before/after a deploy or an incident.

## 7. Sarah's key

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
4. `node scripts/reconcile-office-refunds.js --older-than-minutes 15` run manually once,
   confirm it reports "No pending office refunds..." (nothing stuck from before deploy).
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
- `[Stripe Webhook] charge.refund.updated: reversed $X.XX on payment ...` — R2-L5's
  reversal-correction path firing. Rare; worth a manual look at the booking each time it
  fires, just to confirm the correction matches reality.
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
