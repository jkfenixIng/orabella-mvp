# Role Permissions & Vales Split — ODD Task Record

## Objective

Enforce role-based access across modules without changing business rules:
admin keeps full access; caja and empleado get scoped views; vouchers become
their own module; inventory gains a creation submenu.

## Roles (existing)

- admin, caja, empleado (users may hold several, e.g. empleado+caja).
- Link user→employee via employees.user_id (nullable; admin must link it or
  "own data" filters return empty for that user).

## Access matrix (authorized 2026-09-21)

| Area | admin | caja | empleado |
| --- | --- | --- | --- |
| Home | full | full | full |
| Admin panel | yes | NO | NO |
| Payroll | full | NO (own? no) | own only, view-only |
| Vales (new module) | full | issue/approve for employees | own only, view-only |
| Inventory | full | enter, create product, register movement, NO edit | NO |
| Cash | full | full ops, closed shifts read-only | NO |
| Invoices | full | list; closed = locked (no edit, no detail) | own only, minimal info |

Menu and home show only modules each user may enter.

## Tasks (stable IDs)

- [x] PERM-01 Route guards + menu/home visibility from roles (foundation).
- [x] PERM-02 Split vales into its own module/route (caja issues, no payroll).
- [x] PERM-03 Per-role data filters (own invoices/payroll/vales; caja invoice lock; caja history restriction).
- [x] PERM-04 Inventory creation submenu (create product + movement without scrolling catalog).
- [x] PERM-05 Typecheck, lint, build, tests; fix regressions.
- [x] PERM-06 Record verified evidence; delivery decisions to the user.

## Verification evidence (2026-09-21, PERM-01..PERM-06)

- Commits: afc3b92 (guards+menu), db219bd (vales split), 1bc9e92 (vales scope),
  920b4df (invoices scope), 55c591a (payroll scope), c3817d5 (inventory submenu).
- typecheck: 0 errors. lint (eslint .): clean. tests: 166/166. build: success,
  all routes (incl. /vales) compiled. Push/PR remain user decisions.

## Authorized scope

Branch feat/orabella-mvp. No schema changes unless a migration is approved
explicitly; prefer filtering with existing columns (user_id, employee_id,
status). No changes to auth model or roles seed.

## Acceptance criteria

- A caja user cannot open /admin or /payroll (redirect), sees no payroll/admin
  entries in menu or home.
- An empleado user sees only home + own invoices/payroll/vales.
- Closed invoices are read-locked for caja.
- Typecheck 0, lint clean, tests 166/166+, build success.

## Applicable checks

- From app/: npm run typecheck, npm run lint, npm run build, npm test.
  TDD mode: off.

## Route declaration

- Route: delegated direct (mapping + one writer per slice). Delegation is
  currently blocked by the runtime free-tier restriction, so slices continue
  inline minimally until the transport works again.
- Delivery strategy: ask-on-risk (default). Push/PR remain user decisions.

## Progress

- 2026-09-21: scope authorized and recorded; awaiting clarification on the
  caja history restriction before PERM-03 design.
- 2026-09-21 PERM-01 done (commit afc3b92): roles flow layout→AppShell→MainNav
  with per-link filtering (fail closed); guards on cash/inventory (admin+caja)
  and payroll (admin+empleado); home filters modules and only queries alerts
  for inventory-visible roles. Typecheck 0, lint clean.
- 2026-09-21 PERM-02 done (commit db219bd): /vales route with loading skeleton,
  vouchers logic extracted from payroll-client, nav + home entries (all roles),
  payroll renamed to Nómina. Typecheck 0, lint clean.
- 2026-09-21 PERM-03 done: vales scoped (1bc9e92), invoices scoped with closed
  lock + detailMode (920b4df), payroll detail scoped to own items (55c591a).
  Verification: typecheck 0, lint clean, tests 166/166.
