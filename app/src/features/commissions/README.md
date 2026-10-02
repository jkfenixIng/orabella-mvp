# Módulo `commissions` — reglas ítem × empleado y pago inmediato

Comisión por ítem (producto o servicio) acordada por (ítem × empleado), con
porcentaje y/o valor fijo por unidad, más el pago inmediato de la comisión por
ítem desde la caja del turno abierto. Sin regla rige la tasa plana del empleado.
El porcentaje del empleado no se paga acá: se acumula y se liquida en la nómina
(`payroll`). El modo de comisión de cada línea de factura se declara en
`billing` (`commissionModeSchema`); este módulo resuelve el valor y paga.

El pago inmediato SOLO aplica a facturas `Pagada` (regla del dueño,
2026-10-01): con la factura pagada el destino de la comisión ya quedó definido
—se pagó de inmediato, o se dejó para la nómina—; con una factura `Emitida`
todavía no hay comisión en juego. La guarda vive en el servidor: la lectura de
la factura rechaza con `INVOICE_NOT_PAID` (y `INVOICE_ANNULLED` si está
anulada), y `payCommissionNow` la vuelve a exigir antes de insertar el pago.

- Tablas (migración `016_commissions.sql`): `commission_rules` (`sede_id`,
  `item_type` producto/servicio, `item_id` polimórfico y sin FK —lo valida el
  servicio—, `employee_id` ON DELETE CASCADE, `percent` 0–100 y/o `amount`
  >= 0 con CHECK de al menos uno, `is_active`, `created_at`/`updated_at`;
  único `(sede_id, item_type, item_id, employee_id)`),
  `commission_payouts` (`sede_id`, `employee_id`, `invoice_id`,
  `cash_shift_id`, `method_code`, `base_subtotal`, `percent_applied`,
  `fixed_applied`, `amount > 0`, `paid_by`, `paid_at`; sin
  `UNIQUE(factura, empleado)`: admite pagos parciales y el tope acumulado lo
  valida el servicio). La misma migración agrega `employees.payout_mode` e
  `invoice_items.no_commission` (línea que no comisiona aunque exista regla).
- Migraciones que completan el cálculo: `017_hardening_round2.sql`
  (`payout_mode` pasa a `nomina | inmediato | no_aplica` y endurece la RLS de
  ambas tablas), `020_custom_commission.sql` (`invoice_items.commission_value`
  para ítems `custom`), `027_products_commission.sql`
  (`products.commission_value` sugerida, valor absoluto por unidad) y
  `030_invoice_item_commission_mode.sql` (`invoice_items.commission_mode` +
  `commission_percent_override`, con backfill desde `no_commission` y
  `commission_value`).
- Servicio (`service.ts`): `listCommissionRules` (filtros por ítem o empleado),
  `upsertCommissionRule` (valida ítem y empleado de la sede; upsert por
  `sede_id,item_type,item_id,employee_id`; 23505 → `RULE_CONFLICT`),
  `deleteCommissionRule` (404 si la regla no es de la sede),
  `earnedCommissionFor` (líneas sin `no_commission` × regla o tasa plana;
  exige que la factura esté `Pagada` y devuelve `earned` y, separado,
  `immediateEarned` con solo el origen comisión por ítem), `immediatePaidTotal`,
  `payCommissionNow` (exige factura `Pagada`, turno abierto, método activo,
  empleado distinto de `no_aplica`, tope `ganado − pagado` y el tope de salida
  en efectivo del turno; relee el estado de la factura antes de insertar) y
  `listCommissionPayouts`. Errores
  tipados con `CommissionError` (`NO_OPEN_SHIFT`, `NOTHING_EARNED`,
  `NOTHING_PENDING`, `COMMISSION_OVERPAID`, `METHOD_INACTIVE`,
  `COMMISSION_NOT_APPLICABLE`, `INVOICE_NOT_PAID`, `INVOICE_ANNULLED`, …). Reutiliza
  `requireSession`/`requireAdminSession` (admin), `requireCashWriter`,
  `getOpenShift`/`cashOutUsedInShift` + `cashOutLimitViolation` (caja),
  `listPaymentMethods` (admin) y `writeAudit` (auditoría).
- Cálculo puro (`schemas.ts`): `commissionRuleSchema` (exige % o fijo,
  porcentaje 0–100), `commissionPayoutSchema` (monto > 0), `commissionRuleKey`,
  `hasFixedItemCommission`, `resolveEmployeeLineCommission` y
  `lineHasCommissionBasis` (fuente única por línea, compartida con
  `billing/commission.ts` y `payroll/schemas.ts`), `resolveLineCommission`,
  `employeeLineCommissionOrigin` (`commission | percent | none`),
  `pendingCommission` (nunca negativo) y los `roundMoney`/`moneyEquals`
  reexportados de `billing/schemas`.
- Server Actions (`actions.ts`): `listCommissionRulesAction`,
  `upsertCommissionRuleAction` y `deleteCommissionRuleAction` (solo admin),
  `payCommissionNowAction` (admin/caja), `getPendingCommissionsAction` y
  `listCommissionPayoutsAction` (sesión de la sede). Respuesta
  `{success:false, code, message}` en los fallos.
- API-first (`/api/v1`): sin endpoints propios. No hay route handler de
  comisiones; el pago inmediato se invoca por Server Action desde la factura.
- UI: no hay página propia. El pago inmediato de comisiones vive dentro de
  `app/invoices/invoices-client.tsx`, que importa `commissions/actions` y
  ofrece el modal de comisión al dejar la factura en Pagada.
  `invoices-client.tsx` es un único componente de más de 3000 líneas, así que
  la UI de comisiones se edita en ese archivo y no en `app/commissions/`. Las
  acciones de reglas y `listCommissionPayoutsAction` no tienen UI conectada
  (verificado por búsqueda de uso).
- Tests (`tests/commissions.test.ts`): reglas con % o fijo, cálculo puro,
  resolución compartida por línea (pago inmediato ≡ nómina), comisión y
  porcentaje como conceptos excluyentes, valor fijo por unidad multiplicado por
  la cantidad y el pendiente inmediato que excluye el porcentaje del empleado.
  `tests/commission-mode.test.ts` cubre el modo explícito de la línea y el
  texto de la migración 030. `tests/billing.test.ts` y `tests/payroll.test.ts`
  importan `commissions/schemas` para verificar la paridad del cálculo.
- RLS: `016` habilita RLS con políticas permisivas `USING(true)` temporales;
  `017_hardening_round2.sql` las reemplaza por
  `pol_commission_rules_sede_isolation` y `pol_commission_payouts_sede_isolation`
  para `authenticated` con `sede_id = public.current_sede_id()`
  (deny-by-default sin claim) e indexa las FK. El pago queda auditado
  (`AUDIT_ACTIONS.COMMISSION_PAID`, `payroll.commission_paid`) vía `writeAudit`,
  solo servidor.
- PRD: §5.4 FAC-02 (empleado por línea = base de comisión) y §5.6 PAY-03 (cada
  peso de comisión traza a una línea de factura).

## Límites de lectura

- `listCommissionPayouts` acotado a 200 pagos recientes (`paid_at` desc) y
  `listCommissionRules` sin acotar (filtra por ítem o empleado);
  `getPendingCommissionsAction` calcula el pendiente empleado por empleado.
