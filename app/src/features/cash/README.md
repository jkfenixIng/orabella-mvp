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
- Consolidación T5 (decisión): dual-write. Todo `registerPayment` con
  `invoice_id` inserta en `payments` (totales por turno/día) Y se refleja
  en `invoice_payments` (saldo paid/remaining de la factura en T5). Así
  `invoice_payments` sigue siendo la fuente del cobro por factura y
  `payments` la fuente por turno; al completar el total la factura pasa a
  Pagada y se vincula al turno (`cash_shift_id`). Sin factura, solo se
  inserta en `payments` (ajuste documentado). Ante fallo del reflejo hay
  limpieza best-effort del pago por turno.
- Servicio (`service.ts`): `openShift` (hereda `base_left` anterior o
  `base_configurada`; primera apertura sin alerta; 23505 del índice →
  `SHIFT_ALREADY_OPEN`), `registerPayment` (turno abierto, método activo,
  monto > 0; factura vigente y sin sobrepago), `closeShift` (solo conteo;
  base automática `min(contado, configurada)`, sin justificación;
  `expected_cash` = efectivo del turno; digitales vs apertura + cobrado;
  calcula recogido/diferencia), `getDayView` (siempre hoy en hora Bogotá;
  turnos + acumulado = suma de turnos sin totalizar la base; el contado
  suma solo cerrados), `getHistory` (rango sobre `opened_at` en hora
  Bogotá, 50 máx). Escritura: admin/caja. Reutiliza `requireSedeRole`/
  `resolveSede`, `listPaymentMethods` (T3), `getInvoiceDetail` +
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

## Límites de lectura

- Navegación instantánea: `/cash` entra solo con cajas + turno abierto + vista del día (el historial de 30 días se carga bajo demanda con el filtro); `getHistory` acotado a 50 turnos.
