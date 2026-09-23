# Facturación-Caja: UX completa + reglas de negocio estrictas

## Objective
Unificar Caja y Facturación con UX profesional, reglas estrictas de caja, y auditoría completa.

## Problem (lista completa del usuario)

### Listado facturas
- Columna empleado: solo nombre + ID interno (no documento)
- Columna "SIN COMIS" → cambiar a "¿Tiene comisión?" (solo productos)
- Listado: ID factura, quién abrió, quién cerró (si pagada/anulada), estado con colores correctos (emitida=azul, pagada=verde, anulada=roja)
- Empleados de items: "Camilo, Andrés + 3 más" / "Carolina, Andrés + 1 más" (no saturar)
- Filtros coherentes con columnas

### Crear factura
- **Comisión UX**: Preguntar "¿Tiene comisión?" solo productos (con 💰); servicios nunca; personalizado pregunta + valor
- **Custom con comisión**: Si marca comisión en personalizado → preguntar valor %
- **Overflow en selects**: Producto/Servicio/Empleado → combobox con filtro (escribir para filtrar, no scroll 10k items)
- **Impuestos visibles** en tiempo real al crear
- **Botón "Emitir y pagar"** verde si hay monto > 0 en porciones
- **Cliente opcional** (ya hecho)
- **Validación caja**: Solo si hay turno abierto; solo quien abrió emite; admin override con justificación + audit

### Flujo caja-factura
- Factura se abre en turno de cajera A → cambio de caja 30 min → cajera B cierra factura al terminar servicio
- Caja B cuadrará valores por método de pago
- Solo se abre/ciérra factura por caja abierta (admin override con justificación + audit)
- Caja B cuadrará valores por método de pago
- Admin override para cerrar caja ajena con justificación + audit

### Listado facturas (mejorado)
- Columnas: ID, hora, vendedor (quién abrió), quién cerró (si pagada/anulada), estado (colores: emitida=azul, pagada=verde, anulada=roja)
- Empleados de items: "Camilo, Andrés + 3 más" / "Carolina, Andrés + 1 más"
- Filtros: vendedor, número, fecha, estado
- Caja ve detalle de pagadas/anuladas
- Admin edita pagadas/anuladas con justificación+audit
- Empleado solo ve sus facturas, sin modificar

### Permisos
- Caja ve detalle de pagadas/anuladas
- Admin edita pagadas/anuladas con justificación+audit
- Empleado solo ve sus facturas, sin modificar

### Bugs reportados
- Custom con comisión marcada → no preguntó valor % → [INTERNAL] Error interno al emitir
- Emitir y pagar falla igual
- Listado: empleado muestra documento (debe ser nombre + ID interno)
- Columna comisión mal etiquetada
- Overflow en selects (no filtro)
- Custom con comisión no pregunta valor %

## Why
Experiencia real de salón: cajera abre turno, emite facturas (solo ella), cliente en servicio 30min, cambio de cajera, nueva cajera cobra y cierra factura, caja cuadra por método. Admin puede romper reglas con auditoría completa.

## Scope
Touched:
- `app/app/invoices/invoices-client.tsx` (listado, crear, detalle, validaciones, combobox)
- `app/app/invoices/page.tsx` (props taxes, employees)
- `app/app/cash/cash-client.tsx` (integración facturas en cierre)
- `app/app/cash/page.tsx` (validación turno)
- `app/src/features/billing/service.ts` (validaciones caja, impuestos, comisión, custom)
- `app/src/features/billing/schemas.ts` (comisión por producto, personalizado con valor)
- `app/src/features/billing/actions.ts` (validaciones caja)
- `app/src/features/cash/service.ts` (cierre suma facturas, admin override)
- `app/src/features/cash/actions.ts` (validación caja)
- `app/src/shared/lib/audit.ts` (acciones audit)
- Tests E2E @changed para factura + caja
- Combobox custom para selects con filtro

Out:
- Reportes Excel, multi-sede, agenda, PWA
- Cambios en auth, inventory, payroll, vales, alerts

## Constraints
- Caja estricta: solo turno abierto emite; solo quien abrió emite; admin override con justificación + audit_log
- Comisión: solo productos; servicios nunca; personalizado pregunta + valor %
- Impuestos: calcular y mostrar al crear (incluso borrador)
- Pagar directo: botón "Emitir y pagar" si monto > 0 en porciones
- Listado facturas: ID, hora, vendedor (quién abrió), quién cerró (si pagada/anulada), estado (colores: emitida=azul, pagada=verde, anulada=roja), empleados items resumidos
- Cierre caja: suma facturas por método + admin override audit
- Admin override: solo admin, justificación obligatoria, audit_log
- Empleado: solo ve sus facturas, sin modificar; caja ve detalle pagadas/anuladas; admin edita pagadas/anuladas con justificación+audit
- Convención: suite FULL solo al final; Conventional Commits español neutro; direct-inline

## Tasks (estado real 2026-09-23)
- [x] T1-T7 base + T8-T11 + combobox funcional (commits hasta 2aa1389)
- [x] FEE Recargo tarjeta 5%: migración 019 + backend + UI crear/detalle + auditoría (a690f51)
- [x] Modal agregar ítem + filas compactas + cierre combobox robusto + comisión custom en VALOR (7b1a332)
- [x] 019 re-ejecutable + 020 commission_value (faltaba: rompía detalle y nómina) (1d1e33a); 020 aplicada en prod
- [x] Logs PG diagnóstico en lista/detalle (ad34bee, 93c9da4)
- [x] Listado paginado (20/pág): ID, fecha, abrió, cerró, empleados resumidos, total, estado pill azul/verde/rojo, editar-admin + ver; filtros cerró-por y empleado; botón emitir esmeralda (3b6ca22)
- [x] Caja suma cobros de factura en ventas/esperado (merge día/historial/cierre + 023) + checks confirmación + botón Pagar (aa653c3, 9fe6e22) + Vales a Operación (f479cf4)
- [ ] SECUENCIADO (validado con usuario 2026-09-23, en orden):
  1. Caja día/historial: columnas por método (daviplata/nequi) muestran declarado y siguen en 0 con cobros de factura → mostrar lo cobrado real por método.
  2. Confirmaciones: cambiar CHECKBOXES por MODAL clásico ("¿Está seguro? ..." OK/Cancelar) en emitir, emitir y pagar, pagar y anular.
  3. Listado facturas: 10 por página (hoy 20).
  4. Edición libre para Emitidas (cajera del turno, sin motivo, total se recalcula) + modal de ítems generalizado; edición admin estricta queda para Pagadas.
  5. Vales configurables: días permitidos + topes por día, visibles en caja, alertas admin aceptar/rechazar con motivo, auto-aprobación admin con detalle, edición bloqueada si entró en nómina pagada.
- [ ] Usuario: aplicar 019+020+021+022+023 en PRUEBAS, recargar, verificar combobox/modal/detalle/flujo tarjeta/listado
- [ ] VER full + push

## Authorized scope
Módulos Facturación + Caja. Rama `feat/orabella-mvp`, commits por unidad.

## Acceptance
- Listado: ID, hora, abrió, cerró, estado (azul/verde/rojo), empleados items "Camilo, Andrés + 3 más"
- Crear: valida caja + quien abrió; admin override justificación+audit
- Crear: impuestos visibles; botón "Emitir y pagar" si monto > 0
- Comisión: "¿Tiene comisión?" solo productos 💰; servicios "(sin comisión)"; personalizado pregunta valor %
- Custom con comisión → pregunta valor %
- Selects: combobox con filtro (escribir para filtrar)
- No error [INTERNAL] al emitir custom con comisión
- Emitir y pagar funciona
- Listado: ID, hora, abrió, cerró, estado colores, empleados "Camilo, Andrés + 3 más"
- Caja ve detalle pagadas/anuladas; admin edita con justificación+audit; empleado solo ve sus facturas
- Cierre caja suma facturas por método + admin override audit

## Checks
`npm run typecheck`, `npm test`, `npx playwright test --project=e2e:changed` - SOLO AL FINAL

## Progress
- 2026-09-22: Base hecho (fix emitir, hoja factura, comisión UX básica, cliente opcional, dark mode, validación caja backend, impuestos UI, botón emitir/pagar)
- 2026-09-23: Doc creado. Pendiente: fixes UI + combobox + fixes bugs + tests finales

## Verification evidence
- (pendiente - solo al final)

## Next step
- T8: empleado columna nombre + ID interno
- T9: comisión UX "¿Tiene comisión?" solo productos
- T10: combobox con filtro
- T11: custom comisión pregunta valor
- T12: fix error [INTERNAL] custom comisión
- T13: fix emitir y pagar
- T14: listado completo
- T15: permisos

## Route declaration
- Direct-inline (delegación imposible en este runtime). Sin SDD.