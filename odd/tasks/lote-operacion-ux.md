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
- [x] I1 Inventario producto (HECHO 3bb5c3f 2026-09-23; decisión de producto: comisión sugerida en el producto vía migración 027 — `products.commission_value` absoluta, NULL = sin sugerencia. Inventario la muestra y edita; factura la precarga al elegir el producto; la línea editada a mano manda).
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
- [x] F4 Comisión de producto visible y editable en factura (HECHO 5dc0462 2026-09-23; en el diálogo de ítem, para `item_type === "producto"` con comisión activa se muestra `Comisión: {formatMoney(...)}` y un input editable "Valor de la comisión ($)"; NO se cambió el envío de `commission_value` al backend — sigue enviándose solo para ítems `custom`, para producto la comisión la calcula el backend).
- [x] V3 Config de vales fuera de la pantalla + aprobar/rechazar en modal (HECHO 9386cae 2026-09-23; se quitó de `/vales` el formulario de configuración (wizard de días/topes/tope por día) junto con su estado y handlers muertos — `handleLimits`, `toggleDay`, `allowedDays`, `daysMode`, `capsMode`, `perDayMode`, `dayAmounts`, `maxDay`, `maxWeek` e import `setVoucherLimitsAction`; se conservaron `settings`, `configured`, `capsSummary`, `DAY_NAMES`, el resumen de topes, el mensaje "Los vales no están configurados…" y el bloqueo del botón "Solicitar vale"; los dos campos que flotaban en el listado (observación de aprobación y motivo de rechazo) se movieron a un modal único compartido por aprobar y rechazar — `reviewTarget: { id, action }` — con el error de rechazo mostrado dentro del modal; contratos con el backend intactos; el archivo pasó de 566 a 414 líneas).
- [x] V4 Config de vales en el panel de admin con vista previa y confirmación (HECHO 5a19a90 2026-09-23; reconstruida completa en la pestaña Vales del panel de admin, inline en `admin-tabs.tsx` siguiendo el patrón de las demás secciones, con días permitidos (todos/indicados), topes (sin/diarios/semanales/ambos) y tope por día (mismo/propio); vista previa en vivo del resultado y confirmación con modal OK/Cancelar antes de guardar; contrato con `setVoucherLimitsAction` respetado — `max_per_day` y `max_per_week` número o null, `allowed_days` array 1..7 con al menos 1, `per_day_limits` como array de `{day, amount}`, y con tope propio por día el general va null).
- [x] V5 Vales: elegir empleado con combo y mostrar nombre con id interno (HECHO 49fad73 2026-09-23; la solicitud de vale elige al empleado con un combo y muestra su nombre junto con el id interno).
- [x] V6 Vales: reflujo completo de apertura desde caja (HECHO 8879256 2026-09-23; el vale lo abre la CAJA con turno abierto, no el empleado: sin turno abierto → bloqueado `NO_OPEN_SHIFT`; turno ajeno sin ser admin → `SHIFT_OWNER`. El método de pago arqueable se elige AL CREAR (efectivo/nequi/daviplata) y se valida contra `is_active && arqueable`, no hardcodeado. Dentro de rango (días y topes) el vale nace APROBADO directo; fuera de rango nace PENDIENTE y aparece en las alertas de caja para que el admin apruebe o rechace. Código de aprobación ELIMINADO del flujo y de la UI (decisión de producto): la autorización queda en `approved_by` + observación; la columna `approval_code` se conserva en la BD por compatibilidad (histórica, nullable, sin uso), NO se dropeó. Regla de dinero (decisión de producto): un vale PENDIENTE no toca caja; uno APROBADO descuenta del arqueo por su método. Migración nueva `028_voucher_payment_method.sql`: `method_code` + `cash_shift_id` nullable en `voucher_requests` (re-ejecutable). Tests: +7 (235). LIMITACIÓN CONOCIDA aceptada explícitamente por el usuario: si la caja ya entregó el efectivo y el admin rechaza después, ese dinero salió del cajón pero el sistema no lo registra → el cierre puede mostrar un faltante no explicado por el sistema; no es un bug. Migración 028 aún NO aplicada en PRUEBAS).
- [x] F5 Facturación: comisión visible y editable en emisión y edición (HECHO dc610f5 2026-09-23; en las tablas de emisión (borrador) y edición los ítems ya agregados muestran su comisión: `custom` con input de dinero editable en la fila; `producto` muestra la REGLA vigente (`Según empleado: X%`) porque el monto lo calcula el backend al emitir (no se inventa el número); `servicio`/`no_commission` → "Sin comisión". Motivo: la cajera puede tipear 1000 en vez de 10000 y, al no verlo listado, no detecta el error. Soporte: `buildCreatePayload` ahora envía `commission_value` para `custom` (antes lo descartaba), con validación — cambio de contrato contenido y verificado).
- [x] C2 Caja: valor de vales por turno (HECHO d8d23c4 2026-09-23; se expuso `vales: number` en `DayShiftView` (total absoluto de salida) poblado en los 3 lugares —`getDayView`, `getHistory`, `closeShift`— y en `CloseShiftResult`. Columna "Vales" en la tabla de día e historial para TODOS los roles (la cajera necesita ver por qué bajó su esperado), ubicada antes de "Base final". Función pura `sumMethodTotal` en `cash/schemas.ts` (probada); degrada a 0 si la migración 028 no está aplicada. Se limpió el render muerto de `approval_code` en `cash-client.tsx`. Tests: +3 (238)).
- [x] N1 Nómina: diseño y requisitos (HECHO 00de702 2026-09-23; auditoría: `payroll-client.tsx` YA estaba en tokens; las clases ad-hoc estaban en `page.tsx` (2) y `loading.tsx` (3) y quedaron en 0. UX: textos de progreso en botones (Abriendo…/Calculando…/Pagando…/Cerrando…) y accesibilidad (`htmlFor`/`id`, `aria-expanded`, `aria-controls`, `aria-label` contextual). Estructura: 2 subcomponentes presentacionales (`PeriodDetailTable`, `ExpandedItemPanel`). Contrato con backend y cálculo INTACTOS, verificado por conteo de invocaciones).
- [x] ADM1 Panel admin: modular y unificado (HECHO 01a3b54 2026-09-23; `admin-tabs.tsx` pasó de 1929 a 111 líneas y queda como orquestador: type `Tab`, tabs y layout. 6 secciones extraídas a `app/app/admin/admin-sections/`: employees, users, taxes, methods, vales, cash. Constantes en `admin-styles.ts` (único hogar) y helpers en `admin-shared.ts` (`ActionResult`, `toNumber`, `formatMoney`, `ROLE_OPTIONS`); cada sección importa de ahí. Clases ad-hoc: 69 → 0. Cero cambios de flujo, verificado por conteo de invocaciones de acciones. Código muerto preexistente reportado y NO tocado: el diálogo "Nuevo usuario" de `UsersSection` es inalcanzable, nunca se llama `setCreateOpen(true)`).

## Preguntas abiertas (decisión de producto, bloquean solo su tarea)
- P1 (I1-comisión) RESUELTA 2026-09-23: comisión sugerida en el producto (migración 027 + precarga en factura).
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
- 2026-09-23: I1 hecho (3bb5c3f). Decisión de producto: comisión sugerida en el producto. Route: direct-inline (6 archivos).
- 2026-09-23: F4 hecho (5dc0462). Route: delegated-direct (subagente writer).
- 2026-09-23: V3 hecho (9386cae). Route: delegated-direct (subagente writer).
- 2026-09-23: V4 hecho (5a19a90). Route: delegated-direct (subagente writer).
- 2026-09-23: V5 hecho (49fad73). Route: delegated-direct (subagente writer).
- 2026-09-23: V6 hecho (8879256). Route: delegated-direct (subagente writer).
- 2026-09-23: F5 hecho (dc610f5). Route: delegated-direct (subagente writer).
- 2026-09-23: C2 hecho (d8d23c4). Route: delegated-direct (subagente writer).
- 2026-09-23: N1 hecho (00de702). Route: delegated-direct (subagente writer).
- 2026-09-23: ADM1 hecho (01a3b54). Route: delegated-direct (subagente writer).

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
- I1 (3bb5c3f): `npm run typecheck` 0 errores; `eslint` limpio; `npm test` 11 archivos 221/221 (3 pruebas nuevas: comisión válida/negativa en el schema, migración 027 re-ejecutable con CHECK, documentación de precedencia de la línea).
- PENDIENTE USUARIO: aplicar 027 en PRUEBAS. Sin ella la app degrada sola: el listado de productos omite la comisión (probado una vez por proceso) en vez de romper.
- VERIFICACIÓN 026 (2026-09-23): el proyecto que ve el MCP de Supabase no muestra 023–026 (su última migración es `closed_by_invoices` ≈ 022); el usuario confirma que aplicó 026 en PRUEBAS, entorno distinto al que ve el MCP. No se aplicó nada desde aquí.
- F4 (5dc0462): `npm run typecheck` 0 errores; `eslint` limpio en tocados; `npm test` 11 archivos 221/221.
- V3 (9386cae): `npm run typecheck` 0 errores; `eslint` limpio en tocados; `npm test` 11 archivos 221/221.
- V4 (5a19a90): `npm run typecheck` 0 errores; `eslint` limpio en tocados; `npm test` 11 archivos 221/221 (verificación sobre HEAD 5a19a90).
- V5 (49fad73): `npm run typecheck` 0 errores; `npx eslint app src` 0 errores (1 warning preexistente y ajeno en `app/app/error.tsx`); `npm test` 11 archivos 238/238 (verificación integral sobre HEAD 01a3b54).
- V6 (8879256): `npm run typecheck` 0 errores; `npx eslint app src` 0 errores (1 warning preexistente en `app/app/error.tsx`); `npm test` 11 archivos 238/238 (verificación integral sobre HEAD 01a3b54).
- F5 (dc610f5): `npm run typecheck` 0 errores; `npx eslint app src` 0 errores (1 warning preexistente en `app/app/error.tsx`); `npm test` 11 archivos 238/238 (verificación integral sobre HEAD 01a3b54).
- C2 (d8d23c4): `npm run typecheck` 0 errores; `npx eslint app src` 0 errores (1 warning preexistente en `app/app/error.tsx`); `npm test` 11 archivos 238/238 (verificación integral sobre HEAD 01a3b54).
- N1 (00de702): `npm run typecheck` 0 errores; `npx eslint app src` 0 errores (1 warning preexistente en `app/app/error.tsx`); `npm test` 11 archivos 238/238 (verificación integral sobre HEAD 01a3b54).
- ADM1 (01a3b54): `npm run typecheck` 0 errores; `npx eslint app src` 0 errores (1 warning preexistente en `app/app/error.tsx`); `npm test` 11 archivos 238/238 (verificación integral sobre HEAD 01a3b54).
- Auditoría de paleta cruda (HEAD 01a3b54): 0 clases `slate-/red-/green-` en `app/app/admin` (incluye `admin-sections/`) y en `app/app/payroll`. Residuales preexistentes fuera del alcance migrado de esta tanda: `app/app/cash/cash-client.tsx` 13, `app/app/cash/loading.tsx` 4, `app/app/cash/page.tsx` 2 y `app/app/vales/loading.tsx` 2. Divergencia conocida y aceptada: `app/app/vales/page.tsx` 2 (y `app/app/invoices/page.tsx`, fuera del alcance de la búsqueda). Verificado por conteo: ninguno de estos archivos aumentó sus clases ad-hoc respecto de 8879256~1 (no hay regresión).
- Auditoría `approval_code` (HEAD 01a3b54): 0 referencias en `app/app/` (UI). Decisión documentada: en `src/features/payroll` la columna sigue existiendo a propósito (histórica) — `service.ts` L221/232/235 la selecciona y `README.md` L24 la describe como "histórico, ya sin uso"; no es un fallo.

## Next step
- S1 bloqueado por P2 (alcance de Catálogos): espera decisión del usuario.
- Aplicar las migraciones 026 (vales) y 027 (comisión de producto) en PRUEBAS si todavía no están.
- Pruebas manuales de runtime (no verificables desde aquí, no hay runtime de UI): `/services`, wizard de vales en el panel de admin, modal de aprobar/rechazar vales, comisión del producto en factura.
- PENDIENTE REAL de este lote (6 unidades nuevas, HEAD 01a3b54):
  - (a) Aplicar la migración 028 (`voucher_requests.method_code` + `cash_shift_id`) en PRUEBAS; sin ella el arqueo degrada solo (vales en 0).
  - (b) Pruebas manuales de runtime: flujo completo de vale desde caja, columna Vales en caja, comisión en emisión/edición, nómina y panel admin modular.
  - (c) Divergencia conocida: los `page.tsx` de `app/app/invoices` y `app/app/vales` siguen con `slate-*`.

## Route declaration
- Delegated-direct por item (writer trigger 2+ archivos); inline solo mecánico de 1 archivo.
- Corrección 2026-09-23: en esta sesión la delegación a subagentes SÍ funcionó y se usó en todos los trabajos de este lote (F4, V3, V4 y las 6 unidades nuevas: 49fad73, 8879256, dc610f5, d8d23c4, 00de702, 01a3b54). Las notas previas de "delegación imposible en este runtime" quedan sin efecto.
