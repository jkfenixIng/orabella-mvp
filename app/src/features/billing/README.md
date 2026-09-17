# Módulo `billing` (reservado — T5)

Factura interna (sin DIAN): ítems producto/servicio/custom, empleado por línea,
descuentos, snapshot de impuestos (`invoice_taxes`), estados
Emitida/Pagada/Anulada (anulación con motivo + reversión de stock), consecutivo
por sede sin huecos bajo concurrencia, cobro dividido por método.

- Tablas (T5): `invoices`, `invoice_items`, `invoice_taxes`.
- PRD: §5.4 FAC-01…07, §9.1, §10 Factura, plan paso 4 (§12).
