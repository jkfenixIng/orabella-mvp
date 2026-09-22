# Alertas admin — bandeja en la app

## Objective

Admins see mismatch/lockout alerts inside the app (menu badge + `/alerts`
inbox with read state), instead of audit rows nobody reads.

## Problem

"Se informó a los administradores" writes `audit_logs` rows through
`writeAudit`, but no channel delivers them: no email, no SMS, no inbox.
The records exist; nobody looks at them.

## Scope

New: `supabase/migrations/011_alert_inbox.sql`,
`src/features/alerts/{schemas,service,actions}.ts`,
`app/alerts/{page,alerts-client}.tsx`, `tests/alerts.test.ts`.
Touched: `app/layout.tsx`, `src/shared/components/{app-shell,main-nav}.tsx`.

## Constraints

- Admin-only end to end (page gate, action gates, sede-scoped writes).
- Alert set: `cash.shift_open_mismatch`, `cash.shift_close_mismatch`,
  `auth.login_locked`. Plain audit stays untouched.
- Read state lives on `audit_logs` (`is_read`/`read_at`); service_role
  bypasses RLS, no policy changes.
- Fixed page size 10, newest first, unread filter.
- No new dependencies.

## Tasks

- [ ] A1 Migration 011: `is_read`/`read_at` on `audit_logs` + index.
- [ ] A2 Alerts backend: schemas (page schema, page size), service
      (list/count/mark-read/mark-all, user names joined), actions
      (admin gates).
- [ ] A3 `/alerts` page + client: list, Todas/Sin leer filter, pager,
      mark one/all as read, human text per action (values visible:
      admin-only surface).
- [ ] A4 Menu: Alertas link (admin) with unread badge; count plumbed
      layout -> AppShell -> MainNav.
- [ ] A5 Verify: typecheck, eslint on touched files, full tests.

## Acceptance

- Mismatch/lockout creates an unread alert; admin sees the badge on
  login and the item in `/alerts` with its detail.
- Marking read (one/all) clears badge and filters correctly.
- Non-admin gets redirected from `/alerts` and sees no link.
- No capped-range data loss (count + pages like history).

## Checks

`npm run typecheck`, eslint on touched files, `npm test`.

## Progress

- A1 done: migration file + applied to the project
  (`alert_inbox_read_state`, success).
- A2 done: schemas/service/actions (admin gates, sede-scoped).
- A3 done: `/alerts` page (admin gate) + client (filter, pager,
  mark one/all, per-action detail with values).
- A4 done: Control group + Alertas link with unread badge; count
  plumbed layout -> AppShell -> MainNav.
- A5 evidence: `npm run typecheck` 0 errors; `npx eslint` clean on all
  touched files; `npm test` 10 files, 173/173 passed.
- B1 done: diagnosed INTERNAL as schema drift (app DB missing 011);
  removed risky empty `.match`; schema errors now actionable
  (`SCHEMA_MISMATCH` naming migrations 011/012).
- B2 done: migration 012 (`review_note`, `reviewed_by`) + applied.
- B3 done: review requires justification (one + bulk with shared note);
  reviewed-by shown on read items.
- B4 done: home shows unread cash alerts to admin (inventory pattern).
- B5 evidence: typecheck 0; eslint clean; `npm test` 10 files,
  174/174 passed.
- C evidence: badge refreshes on review (`router.refresh`); shift
  review state joined into day/history views; Diferencia is Sí/No +
  Revisada + Justificación dialog (admin); bulk review removed;
  alerts namespaced by module (`ALERT_MODULES`, partition tested);
  filters grouped Estado/Módulo; typecheck 0; eslint clean;
  `npm test` 175/175.
- D evidence: open-mismatch audit filed against the created shift
  (was: register, unjoinable); review lookup covers open+close
  (`assembleShiftRevision`, tested); justification dialog lists all
  notes; typecheck 0; eslint clean; `npm test` 176/176.
- E evidence: diagnosed double-attachment from 013's 15-min window on
  rapid testing (orphan 01:44 audit glued to 01:49 shift); 014 detaches
  non-exact matches back to register level; going forward exact-id
  filing makes overlap impossible.
