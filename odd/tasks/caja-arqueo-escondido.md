# Caja — hidden count, auto base, dialogs, session name

## Objective

Close the cash antifraud loop: blind counts everywhere, automatic next base,
dialogs that always close cleanly, role-scoped visibility, and the session
owner's name in the menu.

## Problem

- Cash close asks for `base_left` and a shortfall justification, revealing the
  expected base (breaks the hidden-count method).
- Day/history API routes leak all shifts and sensitive totals to any role.
- Cash success/confirm messages reveal declared-vs-expected and
  withdrawn/difference to non-admin.
- Dialogs outside inventory don't reset state on Cancel (stale step/counts on
  reopen); cash close has no Cancel at all in the confirm step.
- No visible reference of who is logged in.

## Scope

`app/app/cash/cash-client.tsx`, `app/app/cash/page.tsx`,
`app/src/features/cash/schemas.ts`, `app/src/features/cash/service.ts`,
`app/app/api/v1/cash/day/route.ts`, `app/app/api/v1/cash/history/route.ts`,
`app/app/invoices/invoices-client.tsx`, `app/app/payroll/payroll-client.tsx`,
`app/layout.tsx`, `app/src/shared/components/app-shell.tsx`,
`app/src/shared/components/main-nav.tsx`, `app/tests/cash.test.ts`.
Inventory dialogs are the reference pattern and stay untouched.

## Constraints

- API-first: server actions and REST routes share the service logic.
- Audit trail for closes/mismatches stays (admin-visible).
- `closeShiftSchema` keeps `counted_cash`, `counts`, `confirmed`; `base_left`
  becomes optional and is always recomputed server-side when absent.
- No new dependencies.

## Tasks

- [ ] D1 Dialogs close on Cancel with state reset (inventory pattern):
      cash open, cash close (both steps + Cancel in confirm), payroll detail,
      invoices create. Inventory untouched.
- [ ] D2 Automatic close base: `resolveClosingBase(counted, configured) =
      min(counted, configured)`; service computes `base_left`, drops the
      shortfall-justification rule; UI never asks base/observation; tests
      updated.
- [ ] D3 Hidden count in UI: day table + totals hide Esperado/Base
      dejada/Recogido/Diferencia from non-admin; close confirm/success
      messages gated by `isAdmin`; remove base formula footnote.
- [ ] D4 Server scoping: `GET cash/day` filters to own shifts for non-admin
      (mirror action); `GET cash/history` requires admin (mirror action).
- [ ] D5 Session name under the theme toggle (layout -> AppShell -> MainNav).
- [ ] D6 Verify: `npm run typecheck`, `npx eslint` on touched files,
      `npm test -- tests/cash.test.ts`.

## Acceptance

- Closing asks only counts; base follows min(counted, configured); no
  justification is ever requested.
- A `caja` user never sees esperado/recogido/diferencia (UI nor API).
- Admin sees day/history of every user; caja only its own.
- Every dialog closes on Cancel/Esc/overlay with clean state on reopen.
- Menu shows who is logged in below the theme toggle.

## Checks

Per-task applicable functional checks; `npm run typecheck`, eslint on
touched files, cash tests. No review cycle per checkbox.

## Follow-up (testing round)

- [x] F1 Blind close total: removed the live cash total from the close
      counts step and every number from the confirm step.
- [x] F2 Timezone bug: day/history bounds carried no offset, so Supabase
      (UTC) hid shifts opened after 19:00 COT from "today". Bounds now use
      fixed `-05:00` (`dayBounds`/`rangeBounds`) and "today" resolves in
      America/Bogota (`bogotaDay`); used by page + both API routes.
- [x] F3 Day view without date selector: always today + refresh button.
- [x] F4 Differences message verified NOT hardcoded: it reflects
      `methodDifferences` (declared vs recorded payments in the shift).
      Declaring digitals with zero recorded payments flags expected $0
      by design; audit written.
- [x] F5 Cumulative digital expected: close compares declared vs
      opening balance + shift payments (`expectedDigitalTotal`,
      `buildMethodViews`, `fetchCountTotals`); views carry per-method
      paid amounts + close differences.
- [x] F6 Spec columns: Apertura, Estado, Base inicial, Ventas, Efectivo,
      one column per arqueable method, Base final (— when open),
      Diferencia (admin). Totals no longer sum base (a stock, not a
      flow). History items carry the same data. README realigned.
- [x] F7 Non-blocking open: `openShift` returns `{ shift, mismatches,
      firstOpen }`; mismatches audit (except first open) and the shift
      opens with the system base so operation never stops. UI notices
      for clean / mismatch / first-open.
- [x] F8 On-demand + pager + caja columns: day view loads only on
      "Mostrar" (page no longer fetches it; server caps at 50); history
      paginates 10/page with page reset on filter; caja sees only
      Apertura/Estado/Base inicial/Base final, totals are admin-only.
- [x] F9 Server-side history paging: `getHistory` counts + ranges
      (`page`, fixed `HISTORY_PAGE_SIZE = 10`, returns total) so no range
      hides shifts; day view paginates 10/page client-side over the
      server-capped 50.
- [x] G1 Shift ownership: only the opener closes (`assertShiftCloser`,
      403 otherwise); admin override allowed and audited
      (`admin_override`) so the register never deadlocks; UI gates the
      button + override note in confirm; B still can't open while A's
      shift is open (already enforced).
- [x] F10 Honest totals + declared columns + shared table: totals drop
      the `contado` sum (stocks don't add across shifts); method columns
      show declared (cierre, else apertura); one `ShiftsTable` for day
      and history.
- [x] F11 UI copy sweep: internal-mechanics explanations removed
      app-wide (cash open/close/day texts, inventory hints, admin audit
      note, payroll immutable notes, module subtitles); results and
      errors stay, mechanics live in docs.

## Progress

- D1 done: explicit cancel fns + onOpenChange reset in cash open/close
  (confirm step has Volver + Cancelar), payroll detail, invoices create;
  detail dialog also resets split draft.
- D2 done: `resolveClosingBase` pure + service computes `base_left`,
  `OBSERVATION_REQUIRED` removed, tests updated to the new contract.
- D3 done: day table/totals, close confirm/success messages and base
  footnote gated by `isAdmin`; configured-base line gated too.
- D4 done: `GET cash/day` filters own shifts for non-admin;
  `GET cash/history` requires admin.
- D5 done: `userName` plumbed layout -> AppShell -> MainNav, rendered
  under the theme toggle (mobile drawer + desktop sidebar).
- D6 evidence: `npm run typecheck` 0 errors; `npx eslint` clean on all
  touched files; `npm test` 9 files, 166/166 passed.
- F evidence: `npm test` 9 files, 168/168 passed (bogotaDay/dayBounds
  covered); typecheck 0; eslint clean.
- F5/F6 evidence: `npm test` 9 files, 170/170 passed
  (expectedDigitalTotal/buildMethodViews covered); typecheck 0;
  eslint clean.
- F7 evidence: bounds proven at DB layer
  (`2026-09-21T00:00/23:59:59.999-05:00` → `[05:00Z, next 04:59:59Z]`);
  history symptom = stale build or other DB (test DB has zero shifts);
  `npm test` 170/170; typecheck 0; eslint clean.
- F8 evidence: `npm test` 9 files, 170/170; typecheck 0; eslint clean
  on touched files.
- G1 evidence: `npm test` 10 files, 179/179 (owner/admin/peer cases);
  typecheck 0; eslint clean.
- H1 evidence: opened_by/closed_by names joined into day/history
  views; Abrió/Cerró columns in the shared table (all roles);
  `npm test` 179/179; typecheck 0; eslint clean.
- F9 evidence: `npm test` 9 files, 171/171 (history page default/max);
  typecheck 0; eslint clean.
- F10/F11 evidence: `npm test` 9 files, 171/171; typecheck 0; eslint
  clean on touched files.
