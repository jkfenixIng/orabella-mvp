# Módulo `billing` — T5 factura interna (FAC-01…07, sin DIAN)

Factura interna con consecutivo por sede, snapshot de impuestos, estados
Emitida/Pagada/Anulada, reversión de stock al anular y cobro dividido por
método de pago. Sin factura electrónica DIAN (el modelo ya guarda el
snapshot y deja espacio para documentos electrónicos sin reestructurar).

- Tablas (migración `005_billing.sql`): `invoice_sequences` (último número
  por sede), `invoices` (unique `(sede_id, consecutive_number)`,
  `cash_shift_id uuid NULL` sin FK = forward-ref T6), `invoice_items`
  (un solo origen por línea + `employee_id NOT NULL`), `invoice_taxes`
  (snapshot inmutable), `invoice_payments` (porciones por método, registro
  interno T5; los pagos por turno de T6 referenciarán a `invoices`).
- Consecutivo (FAC-05): `next_invoice_number(sede_id)` con
  `SELECT … FOR UPDATE` por sede. El servicio valida todo y pre-verifica
  stock ANTES de reservar el número; el `UNIQUE` impide duplicados.
  PostgREST no agrupa multi-statement en una transacción: ante fallo tras
  la reserva hay limpieza best-effort (compensa OUTs + borra la factura
  parcial). Huecos solo ante fallo de BD entre reserva e insert.
- Servicio (`service.ts`): `createInvoice` (Emitida; Pagada si las
  porciones suman el total; OUT vía `registerMovement` de inventario con
  motivo `FACTURA #N`), `annulInvoice` (solo Emitida/Pagada, solo admin,
  motivo en `cancel_reason`, IN de reversión por producto),
  `splitPayment` (métodos activos, rechaza sobrepago, completa → Pagada).
  Descuentos a nivel factura (más descuento por línea con tope al bruto).
  Escritura: admin/caja. Reutiliza `requireSedeRole`/`resolveSede`,
  `ok()`/`fail()`, `tax_configs` y `payment_methods` de T3.
- API-first (`/api/v1`): `POST/GET /invoices` (filtros estado/fecha),
  `GET /invoices/:id`, `POST /invoices/:id/annul` (solo admin),
  `POST /invoices/:id/payments/split` (equivale al `payments:split` del
  PRD; `:` no es válido en carpetas Windows). Lectura: sesión de la sede.
- UI (`/invoices`, español): lista + filtros + emitir (cliente, ítems
  producto/servicio/custom + empleado + cantidad + precio, descuento,
  porciones por método) + detalle (ítems, impuestos snapshot, cobro,
  anular con motivo, registrar porciones).
- Tests (`tests/billing.test.ts`): un solo origen, totales con 3 tipos +
  descuento + IVA, snapshot solo activos, porciones que cuadran/sobrepago,
  anulación inválida, OUT+reversión (motivos), 10 reservas concurrentes
  1…10 sin huecos (mutex que emula el lock; en BD lo hace `FOR UPDATE`),
  y texto de la migración 005.
- RLS: deny-by-default; políticas por sede endurecidas en T8
  (`008_hardening.sql`: `TODO(seguridad-T7)` cerrado, claim
  `app_metadata.sede_id`). Anulación auditada (`invoice.annulled` vía
  `writeAudit`, solo servidor).
- PRD: §5.4 FAC-01…07, §9 invoices/invoice_items/invoice_taxes, §10 Factura.

## Límites de lectura

- Navegación instantánea: `listInvoices` acotado a 50 facturas por defecto (máx. 100, con filtros estado/fecha); `validateItemRefs` sin N+1 (una query con `IN` por tabla en vez de 2 queries por ítem).
