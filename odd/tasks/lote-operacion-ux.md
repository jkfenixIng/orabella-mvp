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
- [x] F2 Mensajes caja en factura (HECHO bf7dc96 2026-09-23; sin turno/turno ajeno con dueño en emitir/editar/pagar; anular admin-only intacto; aviso temprano en crear).
- [x] F3 Columna Cerrada (HECHO 22cb0ac 2026-09-23; 025 closed_at aplicada por usuario en PRUEBAS).
- [x] B1 Stock no descuenta (HECHO 30a6ae3 2026-09-23; descuento único al EMITIR vía deductStock en inventory/service; 210/210 verde).
- [x] C1 Caja todos los pagos + dueño del turno (HECHO ceeac9a 2026-09-23; columnas todos los activos no-efectivo aunque no arqueables; título "Turno actual de {nombre}").
- [x] G1 Validación temprana caja (HECHO 9d050d3 2026-09-23; bloqueo de entrada a emitir/editar/pagar sin caja propia con motivo y dueño del turno; admin exento; backend sigue validando).
- [x] V1 Vales gating + layout (HECHO 12dd333 2026-09-23; sin config → mensaje + solicitud bloqueada; alta en modal; lista debajo).
- [x] V2 Config vales wizard (HECHO 6fb3f0d 2026-09-23; días todos/indicados → topes sin/diarios/semanales/ambos → tope propio por día o mismo; decisión de producto: el tope por día REEMPLAZA al general ese día; migración 026 vuelve opcionales los topes y agrega per_day_limits jsonb — PENDIENTE de aplicar en PRUEBAS).
- [x] U1 Uniformidad modales (HECHO 673d3cd 2026-09-23; apilado de z-index por nivel en dialog.tsx → el modal de abajo sí se atenúa/desenfoca; overlay manual duplicado eliminado en invoices).
- [x] U2 Uniformidad de estilos (HECHO 4b68c18 2026-09-23; payroll-client y vouchers-client migrados a tokens compartidos — `border-border-color`, `bg-surface`, `text-text-primary/secondary/tertiary`, `primary-600`, `text-error/success` — con `cn`; 0 clases slate/red/green ad-hoc en esos dos archivos).

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
- 2026-09-23: F2 hecho (bf7dc96). Route: direct-inline (delegación imposible en este runtime, constancia). TDD: no configurado (sin runner declarado; verificación ordinaria typecheck+vitest full).
- 2026-09-23: C1 hecho (ceeac9a). Route: direct-inline (2 archivos, writer trigger pero sin delegación posible).
- 2026-09-23: G1 hecho (9d050d3). Bloqueo de entrada (no aviso dentro). Route: direct-inline.
- 2026-09-23: V1 hecho (12dd333). Route: direct-inline (1 archivo).
- 2026-09-23: U1 hecho (673d3cd). Route: direct-inline (2 archivos). Auditoría U2 solo lectura.
- 2026-09-23: PENDIENTE BLOQUEADO V2: requiere DDL (topes opcionales + tope por día) y decisión de producto sobre la forma del tope por día.
- 2026-09-23: V2 hecho (6fb3f0d). Decisión de producto: el tope por día REEMPLAZA al general ese día. Route: direct-inline (5 archivos).
- 2026-09-23: U2 hecho (4b68c18). Route: direct-inline (2 archivos).

## Verification evidence
- F2 (bf7dc96): `npm run typecheck` 0 errores; `npm test` 11 archivos 210/210.
- C1 (ceeac9a): `npm run typecheck` 0 errores; `npm test` 11 archivos 210/210.
- G1 (9d050d3): `npm run typecheck` 0 errores; `eslint` limpio en tocados; `npm test` 210/210.
- V1 (12dd333): `npm run typecheck` 0 errores; `eslint` limpio; `npm test` 210/210.
- U1 (673d3cd): `npm run typecheck` 0 errores; `eslint` limpio; `npm test` 210/210; `playwright --list` 18 tests en 9 archivos.
- Auditoría U2 (solo lectura): todos los clientes usan el Dialog compartido salvo alerts-client (sin modal); `cn` ausente en payroll-client y vouchers-client; invoices conserva 24 clases de hoja-factura (deliberado).
- V2 (6fb3f0d): `npm run typecheck` 0 errores; `eslint` limpio; `npm test` 11 archivos 218/218 (8 pruebas nuevas: normalización, reemplazo del general, sin topes, esquema, migración 026).
- PENDIENTE USUARIO: aplicar 026 en PRUEBAS (topes opcionales + per_day_limits).
- U2 (4b68c18): `npm run typecheck` 0 errores; `eslint` limpio; `npm test` 218/218; 0 clases ad-hoc restantes en los 2 archivos.
- VERIFICACIÓN 026 (2026-09-23): el proyecto que ve el MCP de Supabase no muestra 023–026 (su última migración es `closed_by_invoices` ≈ 022); el usuario confirma que aplicó 026 en PRUEBAS, entorno distinto al que ve el MCP. No se aplicó nada desde aquí.
- (pendiente por item)

## Next step
- I1 y S1 bloqueados por P1 (comisión por producto vs línea) y P2 (alcance de Catálogos): esperan decisión del usuario.
- Probar el wizard de vales en PRUEBAS con 026 aplicada.

## Route declaration
- Delegated-direct por item (writer trigger 2+ archivos); inline solo mecánico de 1 archivo.
