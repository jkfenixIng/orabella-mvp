# Admin empleados — lista, modales y ronda visual

## Objective

Employee admin matches the app's current visual/UX bar: table with
Nombre/Documento/Cargo, filter, view/edit/create in dialogs with plain
language, no hand-typed UUIDs, and full_name stored on the employee.

## Problem

- Employees have no name stored (only linked `users.full_name`, null for
  staff without login); the list shows document as primary key.
- `user_id` asks for a hand-typed UUID.
- Create/edit form lives inline; no view-only mode; no filter.
- Rest of admin needs the same copy/dialog discipline already applied
  elsewhere (no internal-mechanics explanations).

## Scope

New: `supabase/migrations/015_employees_full_name.sql`.
Touched: `test-bootstrap.sql` + `seeds/acceptance.sql` (employee rows),
`admin/schemas|service|actions`, `payroll/actions` (voucher limits action),
`app/admin/page.tsx`, `app/admin/admin-tabs.tsx` (EmployeesSection rebuild,
new Usuarios + Vales tabs, copy pass), `src/shared/components/main-nav.tsx`
(Administración moves to Control), `tests/admin.test.ts`.

Out: sedes UI (single-sede operations; service stays for login/select).

## Constraints

- `full_name` required on create (min 2, max 120, like users);
  backfilled from linked users; legacy blanks impossible after NOT NULL.
- User link via selector (sede users) or "Sin usuario"; never a UUID input.
- Dialogs follow the inventory pattern (explicit cancel + reset on
  `onOpenChange`); view dialog shows no DB internals (no ids/timestamps).
- API-first: actions and REST share the service; no new dependencies.

## Tasks

- [ ] E1 Migration 015: `full_name` + backfill from users + NOT NULL;
      mirror in test-bootstrap and seed names.
- [ ] E2 Backend: schema/service/actions (`full_name`,
      `listSedeUsers` with roles, voucher limits action, user-vs-sede
      check on link); update admin tests.
- [ ] E3 UI employees: table Nombre/Documento/Cargo (+inactive tag),
      text filter, Consultar dialog (non-technical info), Crear/Editar
      dialogs with plain labels, user selector, pay coherence errors.
- [ ] E4 Admin menu to Control + visual round (copy only; inline forms
      stay, config keeps its terms).
- [ ] E5 New tabs Usuarios (role assignment) + Vales (topes) with page
      plumbing.
- [ ] E6 Verify: typecheck, eslint on touched files, full tests.

## Acceptance

- List reads Nombre/Documento/Cargo, filters as you type.
- Consultar shows everything except DB internals; no UUIDs anywhere.
- Creating asks only business fields; nothing auto-generated is typed.
- Employee without login still has a name everywhere (views, selectors).

## Checks

`npm run typecheck`, eslint on touched files, `npm test`.

## Progress

- E1 done: 015 file + backfill; 20 seed rows + bootstrap mirror.
- E2 done: schema/service/actions (`full_name`, `listSedeUsers` with
  roles, user-vs-sede check, voucher limits action already existed);
  admin tests updated.
- E3 done: employees table/filter/view-edit-create dialogs, user
  selector (linked users excluded), plain labels.
- E4 done: Administración moved to Control; other sections needed no
  copy changes (already plain; config keeps its terms).
- E5 done: Usuarios tab (roles per user, self-admin locked) + Vales
  tab (topes) with page plumbing. Sedes UI out (single-sede ops).
- E6 evidence: typecheck 0; eslint clean on touched files; `npm test`
  10 files, 179/179 passed.
- E7 evidence: user creation dialog with roles, null-sede users listed
  with tag, admin password reset with confirm + audit; typecheck 0;
  eslint clean; `npm test` 11 files, 183/183 passed.
- E8 evidence: joint employee+login creation (no duplicated data),
  server safety net (empleado role on create), auto-link both
  directions; typecheck 0; eslint clean; `npm test` 183/183.
