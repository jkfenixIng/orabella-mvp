# Cash Anti-Fraud Control — ODD Task Record

## Objective

Harden cash against theft/shortages: traceable payments only via invoicing,
denomination-based counts at open/close, admin alerts on mismatch, closed
shifts editable only by admins with audit, and scoped visibility.

## Decisions (authorized 2026-09-21)

- No direct payments in cash UI: every product/service payment flows through
  invoicing (traceable). Direct payment server action stays for API compat.
- Opening pre-arqueo: cash counted by denomination (bills/coins), digitals
  by entered total; system compares against previous close; mismatch alerts
  admins via audit log.
- Admin configures per payment method whether it is arqueable.
- Closing: counts with no live difference, digital totals, explicit confirm
  ("cannot modify after"), then system computes surplus/shortage, base left
  and envelope; mismatch message + admin record; silence when balanced.
- Closed-shift edits: admin only, with audit trail.
- History: admin only. Day view: admin all shifts, caja only own.
- Base configurable editable from admin panel (column exists).

## Schema (migration 009_cash_control)

- payment_methods.arqueable boolean NOT NULL DEFAULT true.
- cash_shift_counts: shift_id FK, phase (apertura|cierre), method_code,
  denomination NULL (= digital total), quantity, amount.
- Mismatch evidence: audit_logs (existing) + shift observation.

## Tasks (stable IDs)

- [x] CASH-01 Migration 009 + service types (counts, arqueable, base update, closed-shift edit with audit).
- [x] CASH-02 Admin UI: edit base_configurada + arqueable toggles.
- [x] CASH-03 Remove direct payment from cash UI.
- [x] CASH-04 Opening pre-arqueo UI with validation and admin alert.
- [x] CASH-05 Closing flow (counts, confirm, compute, messages).
- [x] CASH-06 History admin-only + day view scoped (admin all, caja own).
- [x] CASH-07 Typecheck, lint, build, tests; fix regressions.
- [x] CASH-08 Record verified evidence; delivery decisions to the user.

## Verification evidence (2026-09-21, CASH-01..CASH-08)

- Commits: 8e18e2e (backend), bf42f45 (denominations), 5597254 (admin tab),
  c2a1d8f (no direct payments), 255f442 (opening), 9babe22 (closing),
  d6da175 (history+day scope).
- typecheck: 0. lint: clean. tests: 166/166. build: success, all routes.
- Pending DBA: apply migrations 009 + 010 in Supabase. Push/PR user decisions.

## Acceptance criteria

- Opening with mismatched counts blocks start and records an admin alert.
- Closing shows no live difference, asks confirm, then reports result.
- Caja cannot edit closed shifts; admin edits leave audit trail.
- Caja day view shows only own shifts; history requires admin.
- Typecheck 0, lint clean, tests green, build success.

## Applicable checks

- From app/: npm run typecheck, npm run lint, npm run build, npm test.
  TDD mode: off. Migration needs Supabase apply (DBA step, user decision).

## Route declaration

- Delegated direct; delegation blocked by runtime, slices continue inline.
- Delivery: ask-on-risk. Push/PR user decisions.

## Progress

- 2026-09-21: scope authorized and recorded.
- 2026-09-21 CASH-01 done (commit 8e18e2e): migration 009 (arqueable flag +
  cash_shift_counts), counts validation/comparison in open/close with mismatch
  audits, base update + closed-shift edit (admin, audited), schema tests
  updated. Verification: typecheck 0, lint clean, tests 166/166.
- 2026-09-21 Denominations configurable (commit bf42f45): migration 010
  (cash_denominations per sede, COP seed), validation against configured set,
  CRUD actions with cache invalidation. Verification green.
- NOTE: migration 009 needs Supabase apply (DBA step). Extra patterns
  (tolerance, dual control, surprise counts, envelope folio, cash cap) were
  proposed and explicitly declined by the user.
