# Módulo `cash` — T6 caja multi-turno (CAJ-01…06 + base encadenada)

Caja única con varios turnos por día sin solape, apertura con base
encadenada (`opening_base` = `base_left` del cierre anterior), pagos
contra el turno abierto, cierre con conteo obligatorio a ciegas (digitales:
declarado vs apertura + cobrado; la base del próximo turno es automática =
`min(contado, configurada)`, sin preguntarla ni justificarla), vista del
día (siempre hoy, con columnas por método) con acumulado (la base no se
totaliza), historial por fecha.

- Tablas (migración `006_cash.sql`): `cash_registers` (una "Caja única"
  por sede, `base_configurada` default 200000, semilla por sede existente;
  sedes futuras la crean vía servicio al abrir su primer turno),
  `cash_shifts` (índice único parcial `uq_cash_shifts_open_per_register`
  where `status = 'abierto'`; CHECKs: cerrado exige conteo + base +
  derivados + `closed_at`, y `cash_withdrawn = counted − base_left` con
  tolerancia de centavo), `payments` (PRD §9.1: `sede_id`, `cash_shift_id`,
  `invoice_id` nullable, `method_id` + snapshot `method_code`,
  `amount > 0`). Además agrega la FK `invoices.cash_shift_id →
  cash_shifts` (la columna forward-ref llegó en 005; bloque DO idempotente).
- Consolidación T5/T0-a (estado actual del código): el arqueo suma cada
  peso UNA vez. `payments` aporta solo los movimientos del turno SIN
  factura (`invoice_id IS NULL`) y `invoice_payments` aporta los cobros de
  factura del turno, atribuidos por `cash_shift_id` = turno que COBRÓ (no
  el que emitió). Los tres lectores (cierre, vista del día, historial)
  usan esa regla; la migración `031_cash_invoice_payment_integrity.sql`
  materializa la atribución de las filas históricas (su sección 4 advierte
  que eso re-atribuye dinero de turnos pasados ya cerrados).
- `registerPayment` con `invoice_id` escribe PRIMERO el espejo
  `invoice_payments` (con `cash_shift_id` del turno que cobra) y DESPUÉS
  la fila de cajón en `payments` (con el mismo `invoice_id` y `user_id`: es
  el único rastro de quién cobró; `invoice_payments` no tiene columna de
  usuario). El orden es deliberado: ninguna falla puede dejar un `payments`
  con `invoice_id` sin espejo, porque el arqueo ignora esas filas
  (`invoice_id IS NULL`) y ese dinero quedaría invisible. Si el espejo
  falla no hay nada que revertir (P0001 del tope de 031 → `OVERPAID` 422);
  si falla la fila de cajón se borra el espejo y ese DELETE sí verifica su
  error: si también falla, el cobro queda solo en `invoice_payments`
  (visible) y la petición responde `PAYMENT_ROLLBACK_FAILED` (500) con log,
  nunca en silencio. Sin factura, solo se inserta en `payments` (ajuste
  documentado).
- Servicio (`service.ts`): `openShift` (hereda `base_left` anterior o
  `base_configurada`; primera apertura sin alerta; 23505 del índice →
  `SHIFT_ALREADY_OPEN`), `registerPayment` (turno abierto, método activo,
  monto > 0; factura vigente y sin sobrepago), `closeShift` (solo conteo;
  base automática `min(contado, configurada)`, sin justificación;
  `expected_cash` = efectivo del turno; digitales vs apertura + cobrado;
  calcula recogido/diferencia), `getDayView` (siempre hoy en hora Bogotá;
  turnos + acumulado = suma de turnos sin totalizar la base; el contado
  suma solo cerrados), `getHistory` (rango sobre `opened_at` en hora
  Bogotá, 50 máx). Escritura: admin/caja. Reutiliza `requireSedeRole`,
  `listPaymentMethods` (T3), `getInvoiceDetail` +
  `roundMoney`/`moneyEquals` (T5), `ok()`/`fail()`.
- API-first (`/api/v1`): `POST /cash-shifts/open` (equivale al
  `cash-shifts:open` del PRD; `:` no es válido en carpetas Windows),
  `POST /cash-shifts/:id/close`, `GET /cash/day?fecha=` (hoy por defecto),
  `GET /cash/history?desde=&hasta=` (últimos 30 días por defecto),
  `POST /cash/payments`. Lectura: sesión de la sede.
- UI (`/cash`, español): estado del turno (base heredada visible al
  abrir), registrar pago (método/monto/factura opcional), cerrar con
  conteo a ciegas (la base es automática), vista del día siempre hoy con
  columnas por método y acumulado, historial filtrable. No-admin no ve
  esperado/recogido/diferencias; historial solo admin.
- Tests (`tests/cash.test.ts`): base encadenada (primero = configurada,
  N+1 = `base_left` anterior incl. 150000), rechazo doble apertura,
  cierre sin conteo, casos 400/200 y 300/150, base automática
  (`min(contado, configurada)`), esperado digital = apertura + cobrado,
  filtros en hora Bogotá, acumulado = suma de turnos, y texto de la
  migración 006.
- RLS: deny-by-default; políticas por sede endurecidas en T8
  (`008_hardening.sql`: `TODO(seguridad-T7)` cerrado, claim
  `app_metadata.sede_id`). Cierre auditado (`cash.shift_closed` con flag
  `base_incompleta`, vía `writeAudit`, solo servidor).
- PRD: §5.5 CAJ-01…06, §9 cash_registers/cash_shifts/payments, §10 Caja.

## Arqueo por método (003)

- El modo de cada método (`payment_methods.arqueo_mode`) decide su conteo: el
  método `denominations` es el cajón físico (billetes y monedas) y los
  `declared_total` se declaran con un total. Ningún flujo depende del código
  `efectivo`.
- La apertura congela una base por método arqueable activo en
  `cash_shift_method_balances` (misma transacción que el turno).
- Comisiones inmediatas y vales aprobados no pueden dejar el saldo del método en
  el turno por debajo del 50 % de su base. Saldo = base + cobros (`payments` sin
  factura + `invoice_payments`) − comisiones − vales aprobados; las ventas
  reponen el disponible. La autoridad son los triggers de 003
  (`CASH_METHOD_MINIMUM_BREACH`); `assertCashMethodOutflow` da el mensaje antes.
- Turnos abiertos antes de 003 no tienen base: sus salidas por métodos
  arqueables se rechazan (`CASH_METHOD_BALANCE_REQUIRED`) hasta cerrar y abrir.
- Una sola definición de vale que afecta caja (`voucher_is_cash_out` en SQL,
  `isVoucherCashOut` en TS): `approved_by` presente, estado `aprobada` o
  `descontada`, con método y turno. Pendiente y rechazada nunca cuentan. El
  dominio no tiene transición aprobada → rechazada/pendiente: la base la rechaza
  con `VOUCHER_CASH_OUT_IMMUTABLE`, y también un vale con aprobador en estado no
  aprobado (así el token de 001 y el saldo cuentan lo mismo).
- Mover un cobro (`invoice_payments` por la edición de factura, o un `payments`
  directo) entre métodos/turnos/montos se permite solo si ambos métodos siguen
  sobre su mínimo; si no, `CASH_METHOD_BALANCE_UPDATE_BREACH` y no se escribe
  nada. Reescribir con los mismos valores es un no-op. Si el movimiento toca un
  turno abierto antes de 003 (sin bases congeladas), se rechaza siempre con
  `CASH_METHOD_BALANCE_REQUIRED`: «Cierre y abra de nuevo el turno para usar
  arqueo por método.» Un método que pasa a arqueable después de abrir también
  se rechaza si no tuvo base congelada; uno que tuvo base al abrir sigue
  validándose aunque luego se marque `none`.
- Vista interna: «Ver disponible por método» (solo admin) muestra saldo,
  mínimo y disponible del turno abierto. No llega a la factura ni a la vista
  cliente.
- Orden global de locks de caja/factura: `cash_shifts` (FOR SHARE, por id) →
  `cash_shift_method_balances` (FOR UPDATE, por turno+código) → `invoices`
  (FOR UPDATE) → productos (trigger de inventario, por id). Comisiones siguen
  ese orden mediante su trigger. Las dos RPC públicas de edición de factura
  conservan firma, dueño y ACL de 001, pero 003 las envuelve: bloquean primero
  los turnos y balances de los cobros cuyo método cambia y después invocan el
  cuerpo legado, que bloquea la factura. Así no invierten el orden frente a una
  comisión. PGlite caracteriza el SQL/ACL; la concurrencia real se valida en
  PostgreSQL con dos sesiones antes del despliegue.
- Nómina y pagos extraordinarios no entran en esta regla.

## Límites de lectura

- Navegación instantánea: `/cash` entra solo con cajas + turno abierto + vista del día (el historial de 30 días se carga bajo demanda con el filtro); `getHistory` acotado a 50 turnos.
