# Bounce Man Office API

Server-to-server API for the office assistant ("Sarah") to manage bookings, customers,
payments and refunds without going through the admin UI. Mounted at `/api/office/v1`.

This document describes the code as it actually behaves. If it ever disagrees with
`routes/office.js`, `middleware/office-auth.js`, or `lib/api-keys.js`, the code wins —
please fix this file.

## 0. This is NOT the `/api/sarah` router

`/api/sarah/*` is a separate, older router authenticated with a single shared secret
(`x-sarah-key` header checked against the `SARAH_API_KEY` env var). It is unrelated to
this API and rotating `SARAH_API_KEY` has no effect on office API access.

## 1. Authentication

Every request needs an `x-office-key` header:

```
x-office-key: bmo_<64 hex characters>
```

- Keys are minted with `scripts/api-key.js` (below). The **raw key is shown/printed
  exactly once** at creation time (or never, if you piped it in on stdin) — only its
  SHA-256 hash and a 12-character lookup prefix are stored in the `api_keys` table.
- Lookup narrows candidates by the indexed prefix, then does a constant-time
  (`crypto.timingSafeEqual`) comparison of the full hash — a partial/prefix match alone
  never authenticates.
- Missing header, malformed key, unknown key, or a revoked key all return `401`. A
  database error during lookup also fails closed (`401`), never open.
- Keys have **scopes** (see §2) and optional per-refund/daily refund caps (see §5).
- `GET /api/office/v1/whoami` returns the key's name, prefix, scopes and *effective*
  refund caps (after defaults/ceiling are applied) — useful for verifying a key's
  permissions without a database console.

### Minting, listing, revoking, rotating

```bash
# Create a key. Pipe the raw key in on stdin to control it yourself (recommended for a
# secret manager), or omit --stdin usage entirely and let the CLI generate + print one:
openssl rand -hex 32 | sed 's/^/bmo_/' | node scripts/api-key.js create sarah-office-2026-10 \
  --scopes bookings:read,bookings:write,availability:read,availability:write,customers:read,customers:write,payments:read,payments:record,payments:link,refunds:create,reports:read,audit:read \
  --max-refund-cents 10000 --daily-cap-cents 25000

# List keys (prefix + scopes + caps only — never the key or its hash):
node scripts/api-key.js list

# Revoke immediately (no restart needed — the very next request 401s):
node scripts/api-key.js revoke sarah-office-2026-10

# Adjust caps or scopes on an existing key without rotating it:
node scripts/api-key.js limits sarah-office-2026-10 --max-refund-cents 20000
node scripts/api-key.js scopes sarah-office-2026-10 bookings:read,reports:read
```

**Rotation runbook:** create a new key with a new name (e.g. `sarah-office-2027-01`),
update Sarah's secret store, confirm `GET /whoami` returns the new name, then revoke the
old one. On suspected compromise, revoke *first*, then review
`SELECT * FROM api_audit_log WHERE key_name = '<old-name>'` for anything it did.

## 2. Scopes

Format: `area:action` (e.g. `bookings:write`), an area wildcard (`refunds:*`), or the
global wildcard `*`.

**The global `*` wildcard does NOT grant `refunds:create`.** Money-moving refund power
must be granted explicitly — either `refunds:create` by name or the `refunds:*` area
wildcard. This is deliberate (an operator typing `--scopes '*'` for convenience must not
silently also hand out unlimited-looking refund power).

| Scope | Grants |
|---|---|
| `bookings:read` / `bookings:write` | GET/PATCH bookings, POST notes |
| `availability:read` / `availability:write` | GET availability, POST/DELETE blocked-dates |
| `customers:read` / `customers:write` | GET/PATCH customers |
| `payments:read` | GET payments |
| `payments:record` | POST a manual (offline) payment |
| `payments:link` | POST a Stripe Checkout payment link |
| `refunds:create` | POST a refund (**never granted by a bare `*`**) |
| `reports:read` | GET reports |
| `audit:read` | GET this key's own audit trail |

## 3. Every write needs `reason` + `Idempotency-Key`

All non-`GET`/`HEAD` requests must include:
- `reason` (string, in the JSON body) — why this write is happening. Stored in the audit
  trail.
- `Idempotency-Key` header — an opaque string you generate per logical attempt.

Idempotency semantics (mirrors Stripe's own):
- **Same key + same request body** (method, path, and a canonical hash of the JSON body)
  → replays the original stored response. The handler never re-runs, and no new Stripe
  call is made.
- **Same key + a DIFFERENT body** → `422`. This is never treated as a replay — an LLM
  caller that reused a header must be told its retry doesn't match what it thinks it's
  confirming, not shown a stale answer.
- **Same key, different method/path** → `409`.
- A prior attempt that **failed** (4xx/5xx, e.g. a Stripe outage) does **not** lock the
  key — retry with the exact same `Idempotency-Key` and it will be processed fresh. The
  failed attempt is still kept in the audit trail (with its idempotency key renamed off
  to the side), it's just no longer "the answer" for a retry.

`HEAD` is treated exactly like `GET` (read, not write-gated).

Every read and write is recorded in `api_audit_log` (and writes also mirror into
`activity_log` so they show up in the admin UI). The read-audit trail redacts the `q`
query parameter value before storage. **Retention recommendation:** prune
`api_audit_log` rows where `action = 'office_api_read'` after 1 year.

## 4. Money units

**Every `*_cents` field is an integer number of cents.** This includes refunds, payment
links, *and* manual payments (`POST /bookings/:n/payments` takes `amount_cents`, not
`amount` — the legacy dollar field is rejected outright with a 400 telling the caller to
convert). There is exactly one amount-validation helper (`lib/validation.js`'s
`parseCents`) used everywhere: it requires a plain JS number, an integer, greater than
zero, and under whatever cap applies to that field. Strings, booleans, arrays, decimals,
`NaN`/`Infinity`, zero and negative numbers are all rejected with `400` — never silently
coerced.

The admin UI's own manual-payment form still speaks dollars (a decimal string, at most 2
decimal places); `lib/payments.recordManualPayment` is the one shared function both
paths funnel through, and it validates that string strictly (`"100abc"` is rejected, not
silently truncated to `$100`).

## 5. Refund caps and the reservation ledger (C1)

### Defaults and ceiling

A key's `max_refund_cents` / `daily_refund_cap_cents` columns are nullable. **`NULL`
means "use the default," never "no cap."** Defaults and the hard ceiling are all
env-overridable (invalid values fall back to the built-in default, never to unlimited):

| Setting | Env var | Default |
|---|---|---|
| Per-refund default | `OFFICE_DEFAULT_MAX_REFUND_CENTS` | `10000` ($100) |
| Daily default | `OFFICE_DEFAULT_DAILY_REFUND_CAP_CENTS` | `25000` ($250) |
| Per-refund hard ceiling | `OFFICE_REFUND_HARD_MAX_CENTS` | `50000` ($500) |
| Daily hard ceiling | `OFFICE_REFUND_HARD_DAILY_CAP_CENTS` | `100000` ($1,000) |

The **effective** cap is `min(key's own cap or the default, the hard ceiling)` —
computed at request time (`lib/refund-caps.js`), so lowering the hard ceiling later
automatically clamps every key, even ones with a stale higher value stored.

`confirmed_by` is required on every refund and must name an actual human — it is
rejected if empty or equal (case-insensitively) to the calling key's own name.

### The reservation ledger

Every refund request:

1. Validates the booking, `confirmed_by`, `amount_cents` (integer cents), and resolves a
   refundable Stripe payment (explicit `payment_id`, scoped to the booking and requiring
   `status = 'completed'`, or a fallback lookup scoped to the same booking).
2. **In one synchronous `db.transaction()`**, before any Stripe call:
   - Computes `refundable_cents = captured_cents - MAX(webhook-recorded refund_amount,
     sum of this key's own pending+succeeded+needs_review office_refunds rows for this
     payment)`. Using `MAX` (not adding the two) is deliberate: once Stripe's own
     `charge.refunded` webhook lands and updates `payments.refund_amount` for a refund
     this ledger already reserved, the two numbers describe the *same* money from two
     vantage points — summing them would double-count it.
   - Checks that against the effective per-refund cap, the effective daily cap (summed
     from today's Central-time `office_refunds` rows for this key), and the refundable
     remainder.
   - Inserts a `pending` row into `office_refunds`, unique on `(key_id, idempotency_key)`.

   Because better-sqlite3 transactions run fully synchronously, no other request's
   reservation can interleave mid-check — this holds under real concurrency, not just
   when calls happen to be serialized.
3. Calls `stripe.refunds.create` with an **idempotency key derived from the ledger row's
   id** (`office-refund-<ledgerId>`) and `metadata.office_refund_id` set to that same id
   — not from the caller's `Idempotency-Key` header. This guarantees exactly one Stripe
   call per reservation and is what lets the webhook handler and the reconcile script
   find this row again from Stripe's side.
4. Finalizes the ledger row to `succeeded` or `failed` (a Stripe `failed`/`canceled`
   refund status, or a thrown Stripe error, both finalize to `failed` and release the
   reservation — L2). The audit row is written explicitly at step 2 (before Stripe is
   ever called) and again at finalize; it also fires on the response's `close` event, not
   only `finish`, so a client that disconnects mid-request still leaves a record even
   though the Stripe call completes in the background.

Bookkeeping (`payments.refund_amount`, `bookings.total`/`balance_due`) is **not** done by
this endpoint — `routes/webhooks.js`'s `charge.refunded` handler is the single place that
reduces the books, so a delayed or retried webhook can never be double-counted against
what this endpoint already recorded.

### Reconciliation

If the process is killed between reserving a refund and Stripe's response coming back,
the row is left `pending` forever unless swept:

```bash
node scripts/reconcile-office-refunds.js [--older-than-minutes 15]
```

Looks up each stuck `pending` row's refund on Stripe by `metadata.office_refund_id` and
finalizes it to `succeeded`/`failed`, or `needs_review` if Stripe's answer can't be
determined. **`needs_review` still counts against the key's caps** until a human clears
it — it can never be used to silently bypass them. Exits non-zero if any row ends
`needs_review`, so a cron wrapper can alert. Run this every few minutes via cron/systemd
timer; it's safe to run repeatedly.

## 6. Payment links (M2, M3)

`POST /bookings/:n/payment-link`:
- Defaults to the booking's `balance_due`; a custom `amount_cents` may not exceed it
  unless `allow_overpay: true` **and** a non-empty `overpay_reason` are given.
- Hard-capped at $10,000 (`amount_cents <= 1000000`) regardless of balance due.
- Refused on a `cancelled`, `declined`, or `completed` booking.
- Passed a Stripe idempotency key (`office-link-<keyId>-<idempotencyKey>`) and a 24-hour
  `expires_at`, so a retried request can't create two Checkout sessions and a stale link
  can't be paid months later.
- `description` is control-character-stripped and capped at 200 characters (it's shown
  on the Stripe Checkout page and may go out by SMS).

`checkout.session.completed` only **promotes** a `pending` booking to `confirmed`; it
never demotes or re-promotes a `completed`/`cancelled`/`declined` booking, even if a
payment link is paid against it later (M3).

## 7. Booking moves (H5)

`PATCH /bookings/:n` accepts `event_date`, `event_end_date`, `event_start_time`,
`event_end_time` among its allowed fields.

- Moving `event_date` on a multi-day booking **shifts `event_end_date` by the same
  offset** if you don't also supply a new end date — it is never left stale/before the
  new start.
- `event_end_date` must be `>= event_date`; on a same-day booking, `event_end_time` must
  be after `event_start_time`.
- Times must match `HH:MM` or `HH:MM:SS`.
- The availability/conflict check runs whenever **any** of the four date/time fields
  changes, across **every day** in the (possibly multi-day) new range — not just the
  first day. A conflict returns `409` with the specific equipment/date at fault.
- This endpoint **never silently re-prices**. A date-affecting move returns
  `reprice_needed: true` and leaves an internal note; it does not recompute Sunday rules,
  extra-day rates, or the delivery fee.

### Status transitions (M5)

| From | May move to |
|---|---|
| `pending` | `confirmed` (requires a paid deposit, unless `override_unpaid: true`), `cancelled`, `declined` |
| `confirmed` | `cancelled`, `completed` |
| `completed`, `cancelled`, `declined` | *(terminal via this API)* |

Any other transition returns `409`. Confirming an unpaid booking with `override_unpaid:
true` is noted on the booking.

## 8. What's in a customer/payment response (M6)

Customer responses (`GET /customers`, `GET /customers/:id`, and the body of a successful
`PATCH`) are an explicit allow-list: `id, first_name, last_name, email, phone, address,
city, state, zip, tax_exempt, total_bookings, created_at, updated_at`. Ad-attribution/UTM
fields, `tax_exempt_cert`, `total_revenue`, and free-text `notes` are never included.

`GET /customers` without `q` is hard-capped at **25** results regardless of the requested
`limit`; with `q` it may go up to **100**.

Payment responses (`GET /bookings/:n/payments`, and the `payments` array on
`GET /bookings/:n`) are also an allow-list: `id, amount, payment_type, payment_method,
status, refund_amount, notes, created_at`, plus computed `is_stripe_payment` and
`refundable_cents`. `card_last4`/`card_brand` and raw Stripe object ids are never
returned — the refund endpoint takes the internal `id` (`payment_id`), never a Stripe id.

## 9. Rate limits (M7)

- **Reads:** 120/min per key.
- **Writes:** 30/min per key.
- **Refunds specifically:** 10/hour per key, on top of the write limit above.
- **Pre-auth, per IP:** 20 failed authentication attempts / 15 min, then `429` **on further
  failing requests from that IP**. Only attempts that actually fail auth (missing/
  malformed/unknown/revoked key) count — a legitimate key's ordinary 400s/403s from
  business-rule validation never do. Critically, **a request presenting a valid, active
  key always proceeds, regardless of that IP's failure count, and never itself counts
  against the limit** — this is IP-scoped throttling of *bad* traffic only, never a way
  to lock out a real caller. That matters because Sarah's own egress IP (or a proxy that
  collapses many distinct clients to one `req.ip`) could otherwise share an IP with
  unrelated bad traffic and be denied service for 15 minutes despite her key being
  perfectly valid.
- The site-wide `/api/` limiter (100 requests/15 min/IP, in `server.js`) **skips**
  `/api/office`, the same as `/api/sarah` and `/api/webhooks` — the office API has its
  own limiters above and must not be throttled by the public-facing one.

## 10. Environment variables

| Var | Required | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | Consider a **restricted key**: write access to Refunds and Checkout Sessions, read access to Balance/Payouts. |
| `STRIPE_EVENT_WEBHOOK_SECRET` | Yes | Refunds are booked into the DB **only** by the `charge.refunded` webhook — refund bookkeeping silently stalls without this. |
| `BASE_URL` | Yes | Used for payment-link success/cancel redirect URLs. |
| `DB_PATH` | Yes | SQLite file path. |
| `OFFICE_DEFAULT_MAX_REFUND_CENTS` / `OFFICE_DEFAULT_DAILY_REFUND_CAP_CENTS` | No | See §5. |
| `OFFICE_REFUND_HARD_MAX_CENTS` / `OFFICE_REFUND_HARD_DAILY_CAP_CENTS` | No | See §5. |
| `SARAH_API_KEY` | Yes (for `/api/sarah`) | **Not** used by the office API. |

The office API needs **no dedicated env var of its own** — its credentials live in the
`api_keys` table, provisioned via `scripts/api-key.js`.

### Stripe webhook configuration

The endpoint (`/api/webhooks/stripe`) must subscribe to at least:
- `checkout.session.completed` — records payments (deposits and office payment-links).
- `charge.refunded` — the only place `payments.refund_amount`/`bookings.total` are
  reduced. Idempotent and monotonic against out-of-order delivery (H1): a stale/
  out-of-order event can never rewind `refund_amount` or over-reduce a booking's total.
- `charge.refund.updated` — marks an `office_refunds` ledger row `failed` if Stripe
  itself later fails/cancels a refund that had already looked like it succeeded.

## 11. Endpoints

| Method | Path | Scope |
|---|---|---|
| GET | `/whoami` | any valid key |
| GET | `/bookings` | `bookings:read` |
| GET | `/bookings/:n` | `bookings:read` |
| PATCH | `/bookings/:n` | `bookings:write` |
| POST | `/bookings/:n/notes` | `bookings:write` |
| GET | `/availability` | `availability:read` |
| POST | `/blocked-dates` | `availability:write` |
| DELETE | `/blocked-dates/:id` | `availability:write` |
| GET | `/customers` | `customers:read` |
| GET | `/customers/:id` | `customers:read` |
| PATCH | `/customers/:id` | `customers:write` |
| GET | `/audit` | `audit:read` (own key's rows only) |
| GET | `/bookings/:n/payments` | `payments:read` |
| POST | `/bookings/:n/payments` | `payments:record` |
| POST | `/bookings/:n/payment-link` | `payments:link` |
| POST | `/bookings/:n/refunds` | `refunds:create` |
| GET | `/reports/summary` | `reports:read` |
| GET | `/reports/outstanding` | `reports:read` |
| GET | `/reports/payouts` | `reports:read` |

Every mutating endpoint supports `dry_run: true`, which previews the result (including
the current caps/refundable balance for refunds) without writing anything or calling
Stripe.
