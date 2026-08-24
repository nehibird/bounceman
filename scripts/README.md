# scripts/ — operational scripts

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
