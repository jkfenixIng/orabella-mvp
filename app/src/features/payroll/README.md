# Módulo `payroll` (reservado — T7)

Nómina y vales: periodos borrador/cerrado (cerrado inmutable), cálculo
fijo + comisiones desde facturación + bonos − vales − otros = neto con
`detail_json` por factura/ítem, pago en porciones por método, topes de vales
por sede, solicitudes pendiente/aprobada/rechazada/descontada con aprobación
admin y código dinámico sobre topes.

- Tablas (T7): `payroll_periods`, `payroll_items`, `payroll_payments`,
  `voucher_settings`, `voucher_requests`.
- PRD: §5.6–§5.7 PAY-01…07, §9.1, §10 Nómina/vales, plan paso 6 (§12).
