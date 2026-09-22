# Orabella UI Experience — ODD Task Record

## Objective

Improve the MVP visual and interaction experience without changing business behavior:
- make navigation clearer and less dense on desktop and mobile;
- use dialogs/modals for heavy forms and secondary workflows;
- add route and interaction-level loading feedback;
- keep the existing Next.js, React, TypeScript, Tailwind, shadcn/Radix, and Supabase stack.

## Scope

In scope: shared navigation, route skeletons, module page density, dialogs, responsive layouts, and lazy loading boundaries.

Out of scope: changes to authentication, permissions, database schema, API contracts, business rules, or the legacy `API/` and `front/` applications.

## Tasks (stable IDs)

- [x] UI-01 Audit current UI and preserve existing business behavior.
- [x] UI-02 Standardize shared navigation, mobile drawer, and loading primitives.
- [x] UI-04 Add route/section skeletons and lazy loading boundaries.
- [x] UI-07 Dark mode: map design tokens into Tailwind v4 @theme inline so bg-surface/text-text-primary/border-border-color resolve in both modes; fix inverted hard-coded classes.
- [x] UI-08 Icons: lucide icons in nav groups, module cards, dashboard alerts to reduce flat look.
- [x] UI-09 Navigation performance: measure TTFB per route, keep instant loading feedback, add pending/double-click guards on nav and forms; document dev-vs-prod.
- [x] UI-10 Declutter modules: move heavy cash/invoice sections into dialogs/tabs; one module per slice.
- [x] UI-11 Dashboard alerts: home shows low-stock alerts on entry (same filterLowStock rule as inventory).
- [x] UI-05 Run typecheck, lint, build, and tests; fix regressions.
- [ ] UI-06 Record verified evidence and leave delivery decisions to the user.

## Verification evidence (2026-09-21, commits 03d31df..d223005 + 07ce5fa)

- typecheck: 0 errors. lint (eslint .): clean. build (next build): success, all routes compiled.
- Perf: /login cold 2.25s vs warm 0.18s in dev (compile cost); production behaves like warm.
- Dev server running at http://localhost:3000 for user testing.

## Authorized scope

Resume and continue UI implementation on branch feat/orabella-mvp (user authorized 2026-09-21). No auth/permission/schema/API/business-rule changes. No touch to legacy API/ and front/.

## Acceptance criteria

- Navigation is clear on desktop and mobile with no business-behavior change.
- Heavy forms run in dialogs; routes show loading feedback.
- `npm run typecheck`, `npm run lint`, `npm run build` pass from app/.

## Applicable checks

- From app/: npm run typecheck, npm run lint, npm run build. TDD mode: off (source: odd/tasks/orabella-mvp-rebuild.md, no runner for new Next app).

## Route declaration

- Route: delegated direct (mapper + one writer). Trigger evidence: 4+ files in diff (~2207 insertions across cash/inventory/invoices/payroll/nav + untracked loading/skeleton files). Delegation currently blocked by runtime free-tier restriction, continuing inline in minimal slices with thin reads.
- Delivery strategy: ask-on-risk (default). Forecast and running diff already exceed ~400 authored lines, so slice work-unit commits; push/PR remain user decisions.

## Progress

- 2026-09-21: resumed per user request; mapped uncommitted diff stat; delegation of full map blocked, continuing inline.
- 2026-09-21 UI-02 slice: fixed MainNav sync bug (hook inside useEffect + missing Object.fromEntries) in app/src/shared/components/main-nav.tsx. Typecheck still fails on intermediate UI state (cash inputClass, inventory implicit any + missing ui/lib, page client prop mismatches). No commit yet.
- 2026-09-21 UI-02 cash stabilization: restored inputClass in cash-client, fixed duplicate @/app/app imports in page, commit 03d31df (151 insertions). Remaining: 22 type errors total, 5 in page prop passing, inventory/invoices pending.
- 2026-09-21 UI-02 inventory stabilization: fixed barrel import, typed callbacks, comma operator, removed home heavy-embed, trimmed unused imports. Typecheck 0, lint clean. Commit c609ad1.
- 2026-09-21 UI-02 invoices cleanup: removed unused dialog/lucide imports and dead style consts. Typecheck 0, lint clean. Commit e0ea0c6.
- 2026-09-21 UI-02 payroll + UI-04 skeletons: payroll transitions committed e156be5; empty-interface lint fixed; loading/skeleton primitives committed 295e5e1. Verification: typecheck 0, eslint clean, build success.
- 2026-09-21 UI perf slice: instant navigation (deferred history/alerts, read limits 50/500, design tokens, ui lib, docs). Commit 584796a. Verification: typecheck 0, build success.
- 2026-09-21 Catalog cache: listSedes/listEmployees/listServices/listTaxes/listPaymentMethods wrapped in unstable_cache (tags catalog:*, 1h backstop); upsert actions revalidateTag. Excluded products/invoices/cash/payroll (transactional). Verification: typecheck 0, tests 166/166, build success. Commit 9798e9a.
- 2026-09-21 UI-09 perf: measured login cold 2.25s vs warm 0.18s (dev compile cost); busy/disabled guards verified in invoices (4) and cash; skeletons + read limits + deferred queries already mitigate. No code change.
- 2026-09-21 UI-10 cash payment dialog: moved payment form into Dialog with trigger in current-shift section. Commit 81858a5.
- 2026-09-21 UI-10 cash close dialog: moved shift-close form into Dialog. Cash view now shows status + actions only. Commit bad2771.
