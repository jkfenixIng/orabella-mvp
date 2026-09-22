# Comisiones por producto-empleado y pago (nómina o inmediato)

## Objective

Commissions follow the real agreement: per product/service AND per
employee (percent and/or fixed per unit), with payout in payroll or
immediate from the drawer — every immediate peso audited (how much,
who paid, when, which invoice).

## Decisions (locked)

- Value: percent and/or fixed amount per unit (at least one); both sum.
- Immediate payout from ANY active method (cash, Nequi, Daviplata…);
  close expects per method: apertura + cobrado − pagado.
- Source of truth against double-pay: recorded payouts. Payroll
  (calculate AND pay) subtracts them; detail shows earned / immediate /
  pending.
- No rule for (item, employee) → legacy flat employee rate (fijo = 0).
- Employee contact: email (format only) + birth_date (past) on the
  employee row, shown/edited like the rest.

## Problem

- One flat `commission_percent` per employee for everything: caja on
  `fijo` earns nothing anywhere, and per-product agreements (stylist A
  yes, stylist B no) are unrepresentable.
- No payout channel: everything accrues to payroll; immediate cash
  payments would break the drawer with no trace.

## Scope (backend first, UI next)

New: `016_commissions.sql` (`commission_rules`, `commission_payouts`,
`employees.payout_mode`).
Touched: payroll schemas/service (rule resolution, payout create/list,
calculate + pay integration), cash service (expected deducts payouts),
audit lib + alerts caja module (`payroll.commission_paid`),
`tests/payroll.test.ts`. Bootstrap mirrors.

Out (next turn): rules UI in product/service dialogs, employee
`payout_mode` select, payroll "Pagar ahora" + detail breakdown,
audit viewer surface (inbox already covers it).

Parked for module reviews (memory topics `pending/billing-…` and
`pending/payroll-…`, flip to done when integrated):
- Billing review: `no_commission` per line (schema, insert, selects,
  UI toggle). Column already in 016 + bootstrap.
- Payroll review: rule-based calculate, immediate-paid subtraction in
  calculate + pay, "Pagar ahora" + earned/immediate/pending detail.

## Rules

- Rule key: (sede, item_type, item_id, employee). Polymorphic item_id
  (products or services), app-validated. Inactive rules ignored.
- Line commission = rule ? pct%×subtotal + fixed×qty : legacy flat.
- Line flag `no_commission` beats everything (e.g. dye consumed inside
  the tintura service, not a direct sale): flagged lines earn zero and
  can't be paid out.
- Payout requires: open shift, amount ≤ pending(invoice, employee),
  active `efectivo` method. UNIQUE(invoice, employee).
- Payout writes audit `payroll.commission_paid` (amount, base, rule,
  payer, shift, invoice) + alerts caja module.
- Payroll calculate: commissions = earned − paid (clamped); detail
  carries immediate section. Pay path recomputes and caps at due.
- RLS mirrors cash tables (deny-by-default, sede isolation);
  service_role bypasses as usual.

## Tasks

- [ ] M1 Migration 016 + bootstrap mirror (+ fix bootstrap employees
      missing `full_name` from 015).
- [ ] M2 Schemas/service: rules CRUD, payout create/list with guards,
      `expectedDigitalTotal`-style pure helpers + tests.
- [ ] M3 Payroll calculate + pay integration (subtract recorded).
- [ ] M4 Cash expected deducts payouts; audit + alert wiring.
- [ ] M5 Verify backend (typecheck, eslint, tests).
- [ ] M6 UI next turn (tracked here when started).

## Acceptance (backend)

- Rule beats flat rate; no rule keeps today's numbers exactly.
- Same (invoice, employee) can never be paid twice, in payroll or now.
- Close expected = cash in − immediate payouts.
- Every immediate peso has who/when/invoice/shift in audit + alert.

## Progress

- M1 done: 016 file + bootstrap mirror (tables, employee cols,
  invoice flag); seeds carry names.
- M2/M4 done: commissions schemas/service/actions (rules CRUD,
  payouts with pending-cap, audit+alert), cash expected deducts
  payouts per method, alerts caja module extended, employee auto-link
  both directions, password reset by admin.
- M5 evidence: typecheck 0; eslint clean; `npm test` 11 files,
  183/183 passed.
- Parked (memories `pending/*`): billing `no_commission` wiring,
  payroll calc/pay integration, all commissions UI (rules dialogs,
  payout_mode select is backend-only so far, pay-now, detail).
