# Lote Operación UX: filtros, validaciones caja, vales, uniformidad

## Objective
Ajustes UX y reglas en Facturación, Inventario/Servicios, Alertas, Caja y Vales + uniformidad de modales, sin romper nómina ni arqueo.

## Problem (pedido del usuario 2026-09-23)
1. Facturación lista TODO por defecto; debe listar solo las del día, resto vía filtros fecha.
2. Inventario crear/listar/editar no muestra todo lo del producto (ej. comisión). Igual servicios.
3. Servicios deben gestionarse en Catálogos, no en panel admin.
4. Alertas abren en Todas; deben abrir solo pendientes (revisados = gasto de consulta).
5. Emitir/pagar factura sin caja o con caja ajena: mensajes claros (quién puede pagar/anular).
6. Caja día/historial: ver TODOS los tipos de pago desglosados (aunque sin arqueo). Título turno actual debe mostrar de quién es.
7. Vales sin configurar: mensaje + bloqueo crear hasta configurar. Crear = botón que abre modal; lista debajo.
8. Config vales ordenada tipo wizard: días (todos/indicados) → topes (sin/diarios/semanales/ambos) → si indicados+diarios: tope propio por día o mismo para todos.
9. Validación caja TEMPRANA: al iniciar emisión/edición de factura o vale (no solo al emitir) para evitar trabajo perdido.
10. Blur modal-sobre-modal roto; uniformar tablas/dialogs/modales con componentes reutilizables.
- Base: migraciones hasta 024 ya aplicadas por el usuario (2026-09-23).

## Why
Evitar traer datos innecesarios, evitar trabajo perdido sin caja, vales guiados sin misconfiguración, UI uniforme.

## Scope
Touched:
- `app/app/invoices/invoices-client.tsx` + `page.tsx`, `app/src/features/billing/service.ts`
- `app/app/inventory/inventory-client.tsx`, `app/src/features/inventory/*`
- Servicios/catálogos (ubicación por definir: nuevo `/catalogos` o mover tab admin)
- `app/app/alerts/*`, `app/src/features/alerts/service.ts`
- `app/app/cash/cash-client.tsx`, `app/src/features/cash/service.ts`
- `app/app/vales/*`, `app/src/features/payroll/service.ts` (vales)
- `app/src/components/ui/lib/dialog.tsx` (+ reutilizables)
Out:
- Nómina cálculo, impuestos, métodos de pago, auth, reportes Excel.

## Constraints
- No romper arqueo (declarado vs cobrado) ni nómina (guards VOUCHER_IN_PAYROLL, comisión).
- Convención: suite FULL al final de cada item; Conventional Commits español neutro.
- Tablas/dialogs/modales: mismo look y comportamiento (componentes compartidos).

## Tasks
- [x] F1 Facturación default día (HECHO 59e58b0 2026-09-23; from/to=hoy, vaciar = ver todo; fix TZ Bogotá -05:00 en dateBound — la ventana UTC colaba la noche anterior).
- [ ] I1 Inventario producto: auditar UI vs schema; agregar lo faltante (COMISIÓN: ver pregunta abierta — no existe por producto, vive por línea de factura).
- [ ] S1 Servicios a Catálogos: sacar de panel admin a módulo catálogos (ALCANCE por confirmar).
- [x] A1 Alertas default pendientes (HECHO 2026-09-23; unreadOnly=true en page + client).
- [ ] F2 Mensajes caja en factura: sin turno / turno ajeno, quién puede pagar o anular (emitir, pagar, anular, edición).
- [x] F3 Columna Cerrada (HECHO 22cb0ac 2026-09-23; migración 025 closed_at + columna; ⚠️ correr 025 en PRUEBAS/PROD o el listado falla).
- [ ] C1 Caja todos los pagos + dueño del turno: columnas todos los métodos (desglose ventas) + "Turno actual de {nombre}".
- [ ] V1 Vales gating + layout: sin config → mensaje y bloqueo; botón-crear abre modal; lista debajo.
- [ ] V2 Config vales wizard: días todos/indicados → topes sin/diarios/semanales/ambos → tope por día o general.
- [ ] G1 Validación temprana caja: al abrir crear/editar factura y crear vale (factura o vale), aviso inmediato si no hay turno o no es propio.
- [ ] U1 Uniformidad modales: blur stacking modal-sobre-modal + auditoría de reutilizables.

## Preguntas abiertas (decisión de producto, bloquean solo su tarea)
- P1 (bloquea I1-comisión): comisión por producto NO existe (solo por línea de factura). ¿Agregar campo comisión al producto, o mostrar la de línea?
- P2 (bloquea S1): ¿"Catálogos" = nuevo módulo `/catalogos` con qué secciones, o mover el tab de admin?

## Authorized scope
Módulos Facturación, Inventario, Servicios/Catálogos, Alertas, Caja, Vales. Rama `feat/orabella-mvp`, commits por unidad.

## Acceptance
- Facturas abren en el día; fecha filtrable.
- Alertas abren en pendientes.
- Sin turno: aviso al primer clic en emitir/crear (factura y vale), no tras llenar datos.
- Caja muestra todos los métodos + dueño del turno.
- Vale sin config: mensaje y bloqueo.
- Modales anidados con blur y mismo comportamiento.

## Checks
`npm run typecheck`, `npm test` desde app/ (FULL por item).

## Progress
- 2026-09-23: Doc creado + mapa read-only. Base: migraciones hasta 024 aplicadas por usuario.

## Verification evidence
- (pendiente por item)

## Next step
- F1 Facturación default día.

## Route declaration
- Delegated-direct por item (writer trigger 2+ archivos); inline solo mecánico de 1 archivo.
