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
  `approval_code`, `observation`; descontada y rechazada terminales).
- Servicio (`service.ts`): `openPayrollPeriod` (23505 del índice →
  `PERIOD_DRAFT_EXISTS`), `calculatePayroll` (fijo según `pay_type`
  fijo/mixto + comisiones desde `invoice_items` del rango por `employee_id`
  —solo facturas no anuladas— con `detail_json` por factura/ítem; el fijo
  queda sin reporte; bonos/otros por ajustes; vales pendientes/aprobados del
  rango se descuentan y pasan a descontada; recalcular reproduce el neto),
  `payPayrollItem` (porciones con métodos activos, montos > 0; abonos
  parciales permitidos —40/40/20 en una o varias llamadas— y el acumulado
  nunca excede el neto), `closePayrollPeriod` (inmutable: `assertDraftPeriod`
  bloquea cálculo, pagos y cambios posteriores), `setVoucherLimits`
  (upsert por sede), `requestVoucher` (valida topes día/semana acumulando
  vigentes; si excede queda pendiente con `requires_approval`), 
  `approveVoucher` (solo pendiente; genera `approval_code` de 6 dígitos +
  observación opcional; obligatorio sobre topes), `rejectVoucher` (solo
  pendiente, motivo obligatorio). Escritura: admin (pagos también caja);
  lectura: cualquier rol de la sede. Reutiliza `requireSedeRole`/
  `resolveSede`, `listPaymentMethods` + `getEmployee`/`listEmployees` (T3),
  `roundMoney`/`moneyEquals` (T5), `ok()`/`fail()`.
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
  (topes vigentes + guardar, solicitar, aprobar con código / rechazar con
  motivo + observación).
- Tests (`tests/payroll.test.ts`): mixto 800000+150000+50000−100000−20000 =
  880000 reproducible, fijo sin comisiones, porcentual sin base, neto nunca
  negativo, `detail_json` ordenado por factura/ítem que suma comisiones,
  pago dividido exacto 40/40/20, `SUM_MISMATCH`/`OVERPAID`, cerrado
  inmutable (`PERIOD_CLOSED`), tope día/semana con aprobación obligatoria,
  semana desde el lunes, código de 6 dígitos, terminales sin doble
  descuento, y texto de la migración 007.
- RLS: deny-by-default; políticas por sede endurecidas en T8
  (`008_hardening.sql`: `TODO(seguridad-T7)` cerrado, claim
  `app_metadata.sede_id`).
- Notas: el neto se acota a 0 si los descuentos superan el bruto (el CHECK
  exige `net_pay >= 0`). T8: cálculo (`payroll.calculated`), cierre
  (`payroll.closed`) y aprobación de vales (`voucher.approved` con flag
  `over_tope`) auditados vía `writeAudit` (solo servidor).
- PRD: §5.6 PAY-01…04, §5.7 PAY-05…07, §9
  payroll_periods/items/payments + voucher_settings/requests, §10
  Nómina/vales, plan paso 6 (§12).
