# scripts/ — operational scripts

## api-key.js

Office API key management CLI (`/api/office/v1`, see `docs/office-api.md`). Creates,
lists, revokes, and adjusts the scopes/refund caps of `api_keys` rows. `create` reads the
raw key from stdin when piped in (so it's generated elsewhere and never printed by this
process); otherwise it generates one and prints it exactly once.

## reconcile-office-refunds.js

Sweeps office refund-ledger rows (`office_refunds`) stuck `pending`/`needs_review`, plus
`failed` rows whose error was never classified `definitive` (R2-C1 — a legacy ambiguous
failure from before that fix shipped), and finalizes them against Stripe's own record —
see `docs/office-api.md` §5 for the full design. **Never calls `stripe.refunds.create`** —
only looks a refund up by `metadata.office_refund_id`. Run on a schedule (e.g. every few
minutes via cron); exits non-zero if any row ends `needs_review`, so a cron wrapper can
alert.

```bash
node scripts/reconcile-office-refunds.js [--older-than-minutes 15]
```

## resolve-office-refund.js

The audited, manual escape hatch for a `needs_review` (or old-enough `pending`)
`office_refunds` row that `reconcile-office-refunds.js` couldn't settle on its own — see
`docs/office-api.md` §5. Never calls `stripe.refunds.create`; it only RECORDS an outcome a
human has already confirmed on Stripe's own dashboard/API. `--reason` and `--actor` are
both required. Marking `succeeded` requires `--stripe-refund re_...`; marking `failed`
requires the SAME kind of Stripe confirmation (refuses if a non-failed/non-canceled refund
already exists for the row, or if the lookup itself fails) — both are verified against
Stripe whenever `STRIPE_SECRET_KEY` is set (for `succeeded`: the retrieved refund's status
must be `succeeded` — a live `failed`/`canceled`/`pending`/`requires_action` refund is
refused, never overridable — plus `metadata.office_refund_id`, amount and currency `usd`
must match; a 404 "no such refund" is refused too, as is any other 4xx including a
bad/revoked API key (401), none of it treated as Stripe being down), and both require
`--no-verify` explicitly without Stripe access. **`--no-verify` only covers
network/connection errors, timeouts, 5xx, 429, a missing key, or no Stripe id; any other
Stripe response (any 4xx incl. 401/403/404/409) refuses.** `--stripe-refund`, when given,
must look like `re_...` even with `--no-verify`. A confirmed `failed` also retires the row's
convention as a definitive Stripe failure) so a same-key retry can reserve fresh. Writes an
audit row (`api_audit_log` + `activity_log`, including what was checked against Stripe) in
the same transaction as the status change.

```bash
node scripts/resolve-office-refund.js <ledger_id> succeeded --reason "confirmed on Stripe dashboard by Nehemiah" --stripe-refund re_123 --actor Nehemiah
node scripts/resolve-office-refund.js <ledger_id> failed --reason "confirmed never charged, cancelling the reservation" --actor Nehemiah
```

## cron-bank-sync.js

Daily Plaid refresh + auto-import of card/bank charges into the `expenses` table.
**Runs on the VPS at 06:30 America/Chicago** via crontab → `/opt/bounceman-cron/cron-bank-sync.sh`,
which `docker cp`s this file into `bounceman-web-1` and runs it.

**This file is the canonical copy.** Until 2026-08-24 the only copy lived at
`/opt/bounceman-cron/cron-bank-sync.js` on the VPS — untracked, unreviewed, and not covered by the
deployment checklist. It writes financial rows into the books, so it now lives in git and deploys
through the normal flow. Never edit a copy on the VPS.

### What it will and will not import

Imports: all Chase Ink card charges, plus direct FNBOK debits from 2026-07-14 onward
(the FNBOK scraper already covered everything through 2026-07-13).

**Never imported** — these are balance-sheet movements, not operating costs:

| excluded | why |
|---|---|
| `LOAN_PAYMENTS` Plaid category | paying down a card moves debt, it isn't a cost |
| `%CAPITAL ONE%`, `%ONLINE PMT%`, `%CARD PAYMENT%`, `%PAYMENT THANK YOU%` | owner reimburses himself by paying his personal Capital One card directly |
| `%CHASE CREDIT CRD%` | card payment |
| `%SCHWAB%` | FNBOK→Schwab is an owner reimbursement/draw |
| `%TRANSFER%`, `%FNBOK/P2P%`, `%Debit Memo%`, `%Teller Check%`, `%ATM%`, `%WITHDRAWAL%` | transfers and cash withdrawals; the purchase gets logged separately |

**Deliberately NOT excluded: `TRANSFER_OUT` / `TRANSFER_IN`.** Plaid tags Venmo and Cash App as
transfers, but those are real business spend here (crew payments, the monthly Venmo storage payment).
Excluding the category outright silently dropped an $80 crew payment and the $180 storage/garage-door
Venmo during testing on 2026-08-24. Bank-to-bank transfers are caught by the description filters instead.

### Duplicate guard

The recurring failure was a purchase entered by hand and then imported again from a feed under a
different `payment_method` — 14 such pairs worth $1,158.98 were cleaned up on 2026-08-24.

The guard **flags rather than skips**, so nothing real is silently dropped: if an existing expense has
the same amount, within 5 days, under a *different* payment method, and was not itself created by this
importer, the new row is still inserted but its `notes` are prefixed `REVIEW: possible duplicate of <id>`.
The run log prints how many were flagged.

It is deliberately narrow so genuine repeat charges — the recurring $5.00 Facebook ad debits, for
instance — keep importing normally.

### Suppression list — read this before deleting an imported row

`expense_import_exclusions (txn_id, reason, added_at)`.

**Deleting a wrongly-imported expense is not enough.** The expense id is derived from the bank
transaction id, so the next run just inserts it again. On 2026-08-24 three rows removed during the
books cleanup — both True Light Christmas insurance charges and a duplicated sales-tax remittance —
reappeared on the very next sync.

Whenever you delete an auto-imported row on purpose, add its transaction id here with a reason:

```sql
INSERT OR IGNORE INTO expense_import_exclusions (txn_id, reason)
VALUES ('plaid-XXXX', 'True Light Christmas insurance, wrong entity');
```

The expense id is the transaction id prefixed with `ccimport-`, so strip that prefix to get `txn_id`.
The run log reports how many rows were suppressed.

### Categorization

Description is checked before the Plaid category, because FNBOK rows have no Plaid category.
Ad spend (`FACEBK`, `GOOGLE *ADS`, `META PLATFORMS`) maps to `marketing`; it had been landing in
`supplies`, which made customer acquisition cost impossible to compute.

### Related

- `books-cleanup-2026-08-24/CHANGELIST.md` in the project folder — the data correction this work came from.
