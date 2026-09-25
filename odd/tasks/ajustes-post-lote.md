# Ajustes post-lote: color/contraste, avisos de vales, filtros y escalabilidad

## Objective
Cerrar los 9 pendientes registrados al cierre del lote de operación UX (`odd/tasks/lote-operacion-ux.md`), en la rama `feat/orabella-mvp`, empezando por el sistema de color (reporte "colores chillones").

## Problem (reportes del usuario 2026-09-24, HEAD `2a31627`)
1. **Colores "quedaron peor de chillones"** después del fix `b1325e0`. El usuario precisó su percepción en dos ejes: (a) **los azules son muy eléctricos/saturados** y (b) **lo chillón son los estados verde/rojo/ámbar**.
2. **Vales: un vale sobre el tope no avisa al crearlo.** Deja avanzar sin advertir; debe advertir ANTES y explicar que quedará en revisión del admin. Falta además UX de confirmación en procesos delicados para evitar registros que haya que denegar/eliminar por error humano.
3. **Alertas: filtros mal hechos y sin UX.**
4. **Nómina: el listado de períodos no escala** (con un año de períodos es inmanejable visualmente; falta filtro/organización).
5. **Inventario: `<select>` donde debería ir un combobox con filtro** (registrar movimiento → seleccionar producto).
6. **Nómina individual auditada**: pagar la nómina de UN empleado (renuncia/despido/emergencia) dejando registro de quién y por qué. Decisión de producto ya tomada por el usuario, **regla de negocio pendiente de precisar antes de implementar**.
7. **Facturación: uniformidad de modales.** `invoices-client.tsx` tiene ~256 clases crudas y sus 6 modales no usan `DialogHeader/Footer`. La hoja de factura blanca SÍ se conserva (es un documento, excepción de diseño ya aceptada).
8. **Bug de zona horaria en `app/src/features/admin/schemas.ts:116`**: valida "no futura" con día UTC; entre 19:00 y 23:59 hora Bogotá acepta una fecha futura. Misma familia que el bug ya corregido en nómina.
9. **Migración opcional**: default de `voucher_requests.request_date` al día Bogotá. Verificado que el código siempre envía la fecha, así que solo afecta inserts manuales por SQL. **Requiere decisión del usuario.**

Fuera de este lote (acción del usuario, no código): aplicar `030_invoice_item_commission_mode.sql` en PRUEBAS.

## Why
El usuario ve la app como producto final: los colores saturados y los estados gritones rompen la percepción de producto terminado; un vale sobre el tope sin aviso genera registros que el admin debe denegar; los filtros sin UX y un listado de nómina que no escala impiden operar con datos reales; el bug de TZ acepta datos inválidos.

## Scope
Touched (por item, a confirmar al abrir cada uno):
- `app/src/styles/design-tokens.css`, `app/app/globals.css`, `app/src/shared/lib/ui-styles.ts`, `app/src/components/ui/lib/{button,badge,select,checkbox}.tsx`
- `app/app/vales/vouchers-client.tsx`, `app/src/features/payroll/*` (aviso sobre tope)
- `app/app/alerts/*`, `app/src/features/alerts/*`
- `app/app/payroll/payroll-client.tsx` (+ `src/features/payroll/*` para nómina individual)
- `app/app/inventory/inventory-client.tsx`, `app/src/components/ui/lib/combobox*` (si existe o se crea)
- `app/app/invoices/invoices-client.tsx`
- `app/src/features/admin/schemas.ts`
- `app/supabase/migrations/031_*` (solo si la decisión del item 9 es afirmativa)
Out:
- Cálculo de nómina y contratos con el backend (excepto lo mínimo del item 6), impuestos, métodos de pago, auth, reportes Excel, multi-sede, la hoja de factura impresa.

## Constraints
- No romper: arqueo (declarado vs cobrado), nómina (guards de vale, comisión), el modelo de comisión por ítem (migración 030).
- Nunca inventar una regla de negocio que toque plata: preguntar antes (item 6).
- Delegación: scout read-only para el mapeo, un writer por tarea; tareas que comparten archivo van EN SERIE.
- Verificación por tarea: `npm run typecheck`, `npx eslint app src`, `npm test` (rutas relativas desde `app/`: `app/...` y `src/...`).
- Commits por unidad de trabajo en `feat/orabella-mvp`, sin push.
- Migraciones: no aplicar SQL de escritura (el MCP de Supabase apunta a PRODUCCIÓN); PRUEBAS lo aplica el usuario.

## Tasks
- [ ] **C1** Sistema de color por roles (acción / estado / texto) — el azul eléctrico y los estados gritones. Auditoría de tokens relanzada el 2026-09-25 (scout read-only): inventario de tokens y exposición `@theme inline`, consumidores por rol, tokens muertos, pasos invertidos, matriz de contraste WCAG, headroom de chroma, coherencia de superficies y 2-4 direcciones propuestas con valores exactos. Sin fix hasta cerrar la auditoría y decidir la dirección.
- [ ] **V1** Vales: advertir ANTES de crear un vale que supera el tope, con mensaje explícito de que quedará en revisión del admin.
- [ ] **A1** Alertas: rehacer filtros con UX real.
- [ ] **N1** Nómina: listado de períodos escalable (filtro/organización para un año de datos).
- [x] **I1** Inventario: combobox con filtro — cerrado el 2026-09-25 por decisión del usuario. La premisa era falsa: en `app/app/inventory/inventory-client.tsx:549-572` no hay un `<select>` sino un `Select` de Radix con un `Input` de filtro embebido (`movementProductQuery`, `:110-118`), y el `Combobox` canónico ya existe en `src/components/ui/lib/combobox.tsx` (usado en facturación). El usuario confirmó que inventario/productos está bien como está. Residuo anotado, fuera de alcance: `listProducts` tope en 50 (`src/features/inventory/service.ts:46-49`), así que con catálogo real el filtro no alcanza.
- [ ] **N2** Nómina individual auditada (un empleado, con registro de quién y por qué). **BLOQUEADO hasta precisar la regla de negocio.**
- [ ] **F1** Facturación: uniformidad de los 6 modales (`DialogHeader/Footer`, tokens); conservar la hoja de factura.
- [x] **B1** Fix TZ en `app/src/features/admin/schemas.ts:117` ("no futura" con día Bogotá) — commit `19d6798`.
- [ ] **M1** (opcional, requiere decisión) Default de `voucher_requests.request_date` al día Bogotá.

## Evidence
### C1 — evidencia ya verificada (2026-09-24)
- Light: `--color-primary-600: oklch(0.48 0.23 250)`. Dark: `--color-primary-600: oklch(0.55 0.2 250)`, `--color-primary-700: oklch(0.48 0.2 250)`.
- `b1325e0` bajó la luminosidad del dark 600/700 **manteniendo la chroma** (0.65→0.55 y 0.72→0.48, esta última subiendo chroma de 0.17 a 0.20): mismo "pigmento", menos blanco → se lee más eléctrico, no menos.
- La escala oscura está **invertida**: `.dark` define `--color-primary-800: oklch(0.8 0.12 250)` y `--color-primary-900: oklch(0.9 0.05 250)` (casi blancos). Todo `bg-primary-800/900` en oscuro sería un bloque claro.
- Conflación de roles: el mismo peldaño sirve de **fondo** de botón con texto blanco y de **texto/enlace** (donde hace falta otro rol y otro contraste).
- El lienzo y las superficies no comparten hue: `body` usa `--background: #020617` (azul-negro, hue ≈ 250) en oscuro y `#ffffff` en claro, mientras `--bg-primary` es gris neutro `oklch(0.12 0 0)` y `oklch(0.98 0 0)`.
- `:root` declara un remanente HSL `--color-primary: 175 82%` (hue 175 = cian) sin uso aparente — a confirmar por el scout.
- Escala de estado: light `error-600 oklch(0.45 0.2 25)`, `warning-600 oklch(0.5 0.19 50)`, `success-600 oklch(0.45 0.23 160)`; dark `0.65 0.18 25`, `0.64 0.16 50`, `0.61 0.18 160`. Chromas 0.16–0.23 = cerca del techo del gamut sRGB en esos peldaños.

### B1 — evidencia verificada (2026-09-25)
- Defecto: `birth_date` validaba "no futura" contra el día UTC (`new Date().toISOString().slice(0, 10)`), así que entre 19:00 y 23:59 de Bogotá aceptaba una fecha futura. Misma familia que el bug ya corregido en nómina (`2a31627`).
- Fix: `app/src/features/admin/schemas.ts:117` compara contra `bogotaDay()` de `@/src/shared/lib/dates` (import en `schemas.ts:3`). Cadena del refine sin cambios (regex primero) y mensaje en español idéntico.
- Test de regresión: `app/tests/admin.test.ts:112-130`, con `vi.useFakeTimers()` fijando el reloj en `2026-09-25T01:00:00Z` (= 2026-09-24 20:00 en Bogotá): "2026-09-25" falla y "2026-09-24" pasa. RED observado antes del fix (`expected true to be false`), GREEN después.
- Verificación: `npm run typecheck` 0, `npx eslint src/features/admin/schemas.ts tests/admin.test.ts` 0, `npm test` 14 archivos / 349 tests pasando.
- Sin migración, sin cambios de esquema de BD: la validación es de aplicación.

### Estado del árbol al abrir el lote
- HEAD `2a31627` (`feat/orabella-mvp`).
- Sin commitear y ajenos a este lote: `app/app/vales/loading.tsx` (residual de la migración a tokens: 2 clases ad-hoc → `text-text-secondary` / `border-border-color`) y `opencode.json` (regenerado por gentle-ai, bloque de agentes administrados). `.codegraph/` sin trackear.

## Verification evidence
- **B1**: `npm run typecheck` 0 · `npx eslint src/features/admin/schemas.ts tests/admin.test.ts` 0 · `npm test` 349/349 (14 archivos). RED observado antes del fix y GREEN después, mismo test.

## Next step
- Cerrar la auditoría de tokens de C1 (en curso), decidir con el usuario la dirección del color y recién entonces editar tokens.
- En curso también: mapeo read-only de V1, A1, N1, I1 y F1 para despachar un writer por tarea sin más exploración.
- Aplicar `030_invoice_item_commission_mode.sql` en PRUEBAS (usuario).
- Precisar la regla de negocio de N2 antes de implementarla (el motor ya paga el ítem de un solo empleado y graba `paid_by`; falta definir el "por qué").
- M1 queda en "no aplica" salvo decisión afirmativa del usuario.

## Route declaration
- Delegated-direct: scout read-only (`gentle-ai-explore`) contra `repository_root D:\u\orabella`, autorizado explícitamente por el usuario en esta sesión (la sesión de Pi corre en `C:\Users\juanrodriguezr`, otro clon).
- Un writer por tarea; items que comparten archivo en serie.
