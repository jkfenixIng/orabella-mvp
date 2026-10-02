# Módulo `payroll` — T7 nómina y vales + cierre transversal (PAY-01…07, TRA-02…03)

Nómina mixta con cálculo desde facturación y vales con topes y aprobación.
Último módulo funcional del MVP: cierra la cadena empleado (T3) →
factura con empleado por línea (T5) → métodos de pago (T3/T6) → liquidación.

- Tablas (migración `007_payroll.sql`): `payroll_periods` (`sede_id`,
  `start_date`/`end_date` con `end_date >= start_date`, `status`
  borrador/cerrado default borrador, `created_by`, `closed_at` con CHECK
  cerrado-exige-cierre; índice único parcial
  `uq_payroll_draft_per_range` where borrador), `payroll_items`
  (`period_id` cascade, `employee_id`, `base_fixed`/`commissions`/`bonuses`
  default 0, `deductions_vales`/`other_discounts` default 0, `net_pay` con
  CHECK neto = base + comisiones + bonos − vales − otros con tolerancia de
  centavo, `detail_json` jsonb por factura/ítem; unique
  `period_id,employee_id`), `payroll_payments` (`payroll_item_id` cascade,
  `method_id` + snapshot `method_code`, `amount > 0`, `paid_at` default now,
  `paid_by`, `reference`; trigger `check_payroll_payments_cap`: la suma por
  ítem nunca excede el neto), `voucher_settings` (`sede_id` PK,
  `max_per_day`/`max_per_week >= 0`), `voucher_requests` (`sede_id`,
  `employee_id`, `amount > 0`, `request_date` default current_date, `status`
  pendiente/aprobada/rechazada/descontada default pendiente, `approved_by`,
  `method_code` + `cash_shift_id` (migración 028: método arqueable y turno de
  caja que abrió el vale), `approval_code` (histórico, ya sin uso),
  `observation`; descontada y rechazada terminales).
- Vales reales y deuda del sobrante (migraciones `061_payroll_voucher_debt.sql`,
  `062_payroll_carry_apply.sql` y `064_payroll_partial_carry.sql`):
  `payroll_items.voucher_total` guarda el
  **total REAL** de vales del empleado en el rango del período, FUERA de la
  igualdad del neto; `deductions_vales` sigue siendo lo que se **aplicó**
  (topeado al bruto, con su signo). Cuando un vale supera lo ganado, el
  exceso (el recorte que el tope no pudo descontar) queda como **deuda** del
  empleado en `payroll_discount_carries` (por sede + empleado, con el período
  de ORIGEN y `applied_period_id` nulo mientras está pendiente). La deuda
  pendiente de períodos ANTERIORES se descuenta en el período siguiente
  DENTRO de `other_discounts` —así la igualdad del CHECK de `payroll_items`
  sigue vigente sin modificarla y el empleado lo ve como "otros descuentos"—
  y su trazabilidad vive en la tabla de deudas. El marcado
  (`applied_period_id`) ocurre en la MISMA transacción que el descuento
  (`payroll_apply_atomic`, `062`): un fallo no puede dejar el descuento
  escrito con la deuda todavía pendiente y aplicarla dos veces. La deuda se
  consume SOLO por lo que el tope **aplicó de verdad**: cuando `vales + deuda`
  supera el bruto, el sobrante de la deuda NO se perdona —el ítem lo lleva en
  `debt_remainder` y `payroll_apply_atomic` (`064`) lo re-registra como deuda
  **PENDIENTE** en la MISMA transacción, con este período como origen y
  `origin_kind = 'carry_remainder'`, para que la aplique un período POSTERIOR
  (nunca el actual: su origen no es anterior a sí mismo)—. Una deuda se
  aplica UNA vez; recalcular el mismo período no la duplica (guarda
  `NOT EXISTS` por origen + empleado + `origin_kind`) ni vuelve a marcar una
  ya consumida, y el ítem expone
  `voucher_total` y `pending_debt` (la deuda pendiente de ese período) para
  la UI.
- Servicio (`service.ts`): `openPayrollPeriod` (23505 del índice →
  `PERIOD_DRAFT_EXISTS`), `calculatePayroll` (fijo según `pay_type`
  fijo/mixto + comisiones desde `invoice_items` del rango por `employee_id`
  —regla de negocio: solo facturas `Pagada`; una `Emitida` no comisiona— con
  `detail_json` por factura/ítem; el fijo queda sin reporte; bonos/otros por
  ajustes; vales pendientes/aprobados del rango se descuentan y pasan a
  descontada, y los ya `descontada` del rango siguen contando al recalcular;
  recalcular reproduce el mismo neto),
  `payPayrollItem` (porciones con métodos activos, montos > 0; abonos
  parciales permitidos —40/40/20 en una o varias llamadas— y el acumulado
  nunca excede el neto), `closePayrollPeriod` (inmutable: `assertDraftPeriod`
  bloquea cálculo, pagos y cambios posteriores), `setVoucherLimits`
  (upsert por sede), `requestVoucher` (nuevo flujo: la CAJA con turno abierto
  abre el vale; exige turno abierto y dueño o admin; elige el método arqueable
  al crear; valida topes día/semana y días permitidos —dentro de rango se
  genera directo/aprobada, fuera de rango queda pendiente con
  `requires_approval` y alerta `voucher.requested`—),
  `approveVoucher` (solo pendiente; autorización con `approved_by` +
  observación, SIN código), `rejectVoucher` (solo pendiente, motivo
  obligatorio). Escritura: admin (pagos también caja);
  lectura: cualquier rol de la sede. Reutiliza `requireSedeRole`/
  `resolveSede`, `listPaymentMethods` + `getEmployee`/`listEmployees` (T3),
  `getOpenShiftWithOpener` (T6) para el turno de caja, `roundMoney`/
  `moneyEquals` (T5), `ok()`/`fail()`.
- API-first (`/api/v1`): `POST /payroll-periods` (+ `GET` lista),
  `GET /payroll-periods/:id` (periodo + ítems con pagado/saldo),
  `POST /payroll-periods/:id/calculate` (`{adjustments[]}` opcional),
  `POST /payroll-periods/:id/close`, `POST /payroll-items/:id/payments`,
  `GET/POST /vouchers` (solicitar devuelve `requires_approval`),
  `POST /vouchers/:id/approve`, `POST /vouchers/:id/reject`,
  `GET/POST /voucher-settings` (topes; extra fuera del listado mínimo para
  la UI).
- UI (`/payroll`, español): periodos (abrir, ver, calcular con ajustes
  bonos/otros por empleado, tabla fijo/comisiones/bonos/vales/otros/neto
  con pagado/saldo, detalle expandible por factura/ítem, pagar por
  porciones `método:monto`, cerrar; cerrado muestra inmutabilidad), vales
  (topes vigentes + guardar, caja abre con empleado/monto/método arqueable,
  aprobar o rechazar según rango).
- Tests (`tests/payroll.test.ts`): mixto 800000+150000+50000−100000−20000 =
  880000 reproducible, fijo sin comisiones, porcentual sin base, neto nunca
  negativo, `detail_json` ordenado por factura/ítem que suma comisiones,
  pago dividido exacto 40/40/20, `SUM_MISMATCH`/`OVERPAID`, cerrado
  inmutable (`PERIOD_CLOSED`), tope día/semana con aprobación obligatoria,
  semana desde el lunes, estado inicial directo/pendiente por rango,
  terminales sin doble descuento, y texto de las migraciones 007/024/026/028.
- RLS: deny-by-default; políticas por sede endurecidas en T8
  (`008_hardening.sql`: `TODO(seguridad-T7)` cerrado, claim
  `app_metadata.sede_id`).
- Notas: el neto se acota a 0 si los descuentos superan el bruto (el CHECK
  exige `net_pay >= 0`); el total real de vales NO se pierde por ese recorte:
  vive en `voucher_total` y el sobrante se arrastra como deuda del empleado
  (ver arriba). T8: cálculo (`payroll.calculated`), cierre
  (`payroll.closed`) y aprobación de vales (`voucher.approved` con flag
  `over_tope`) auditados vía `writeAudit` (solo servidor).
- PRD: §5.6 PAY-01…04, §5.7 PAY-05…07, §9
  payroll_periods/items/payments + voucher_settings/requests, §10
  Nómina/vales, plan paso 6 (§12).

## Cadencia de pago y regla del mixto (F3)

Las migraciones `063_nomina_frecuencias.sql` (columnas) y `064` (deuda de
vales) ya están aplicadas. `employees.pay_frequency` y
`payroll_periods.frequency` son `text NULL` con catálogo cerrado
`semanal | quincenal | mensual`. **NULL no es un valor más: es la AUSENCIA de
cadencia** y conserva el comportamiento de hoy (el fijo se prorratea por los
días calendario del período con `prorateFixedSalary`). Mientras falte la
cadencia de cualquiera de los dos lados, ningún camino existente cambia.

### Fracción del fijo por cadencia

Cuando el período y el empleado TIENEN cadencia, la del PERÍODO decide quién
cobra el fijo y con qué fracción, sobre un **mes comercial de 30 días** (el mes
se cuenta como 4 semanas):

| Cadencia del período | Fracción | Fijo del período (ej. mensual 1.500.000) |
| -------------------- | -------- | ---------------------------------------- |
| `semanal`            | `1/4`    | 375.000                                  |
| `quincenal`          | `1/2`    | 750.000                                  |
| `mensual`            | `1`      | 1.500.000                                |

- **Coinciden**: el fijo es `mensual × fracción`, sin mirar los días del rango.
- **Difieren**: el empleado cobra **0 fijo** en ese período; lo paga su propio
  ciclo y pagarlo acá también lo pagaría dos veces. El caso está en
  `resolveFixedSalaryForPeriod`, que devuelve en `basis` cuál de las tres reglas
  aplicó (`cadence`, `other-cadence` o `prorated`), explícito y no inferido.
- **Consecuencia aceptada por el dueño (2026-10-01)**: `1/4` por semana paga
  ≈ 13 sueldos al año (52,14 semanas), no 12. El mes comercial de 30 días es lo
  que produce esa cuenta; no se reabre la decisión.

### Regla del mixto

Un empleado `mixto` cobra, por su bloque fijo + porcentajes, **el MAYOR** entre
su básico del período y los porcentajes de SERVICIOS del período:

| Básico del período | Porcentajes de servicios | Bloque fijo + porcentajes |
| ------------------ | ------------------------ | ------------------------- |
| 300.000            | 400.000                  | 400.000                   |
| 300.000            | 200.000                  | 300.000                   |

- La comparación es **solo contra los porcentajes de servicios**. Las
  comisiones fijas por producto NO entran al máximo y se siguen sumando como
  hasta hoy (`básico 300.000`, `porcentajes 400.000`, `producto 50.000` →
  450.000).
- La regla se reparte sobre las columnas EXISTENTES, sin mover la identidad
  `neto = base_fixed + commissions + bonuses − deductions_vales − other_discounts`:
  - `base_fixed` sigue llevando el básico del período;
  - la parte porcentual de `commissions` pasa a `max(0, porcentajes − básico)`;
  - `max(básico, porcentajes)` = `base_fixed + la parte porcentual de
    commissions`.
- El porcentaje que el básico ABSORBE (`min(básico, porcentajes)`) se ve en el
  detalle como una **línea de ajuste** (`item_type = "ajuste_mixto"`, con su
  monto en negativo): así los porcentajes no desaparecen entre las columnas y la
  suma de `detail_json` vuelve a dar exactamente `commissions`. La línea no
  menciona ninguna factura, así que el candado de nómina cerrada no la confunde
  con una.
- `fijo` y `porcentaje` conservan sus reglas de siempre salvo la fracción del
  fijo de arriba.

Las funciones puras viven en `schemas.ts` (`fixedFractionForFrequency`,
`resolveFixedSalaryForPeriod`, `resolveMixedBlock`, `mixedAbsorbedDetailLine`) y
el cálculo de `computePayrollLines` (`service.ts`) las usa tal cual, tanto en el
borrador como en la corrección de un período cerrado.

## Límites de lectura

- Navegación instantánea: `listPeriods` acotado a 20 periodos recientes, `listVouchers` a 50 vales recientes; la pantalla de vales nace acotada al día de hoy (Bogotá, `date_from`/`date_to` incluyentes) y amplía —o limpia— ese rango desde sus filtros de fecha; el detalle del periodo (ítems + saldos) se carga bajo demanda al seleccionar.
