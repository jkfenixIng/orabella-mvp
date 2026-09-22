# Factura: fix emisión + diálogo como documento

## Objective
Que emitir factura funcione al primer clic y que crear/revisar una factura se sienta como un documento factura real, no un modal genérico.

## Problem
- BUG: el botón "Emitir factura" (`type=submit`) está en `CardFooter` FUERA del `<form>` (form cierra línea 613, footer 615): el clic no dispara submit. Reporte del usuario: "doy emitir factura y no hace nada".
- BUG latente: `setBusy(true)` sin `try/finally` en submitInvoice/submitAnnul/submitSplit: si la acción lanza, el botón queda deshabilitado para siempre.
- BUG latente: el error/notice vive fuera del diálogo (línea ~848, tapado por el overlay): los fallos de validación son invisibles con el modal abierto.
- UX: crear y ver detalle usan el modal genérico (Card + fieldsets + listas). Se pide aspecto de factura: encabezado, cliente, tabla de ítems, totales, cobro.

## Why
Sin el fix, facturar es imposible por UI. Sin el rediseño, la experiencia no se distingue de cualquier formulario.

## Scope
Touched:
- `app/app/invoices/invoices-client.tsx` (único archivo):
  - B1: acciones del diálogo crear DENTRO del form (Cancelar type=button + Emitir type=submit).
  - B2: try/finally en los 3 submits.
  - B3: área de error/notice DENTRO de ambos diálogos (mismo estado).
  - R1: diálogo crear como hoja factura (encabezado, cliente, tabla ítems con subtotal vivo por fila, totales vivos, cobro, footer).
  - R2: diálogo detalle como hoja factura solo-lectura (misma estética + sección Operaciones con split/anulación existentes).
Out:
- Editar-factura como feature (no existe backend update-invoice; anulación + nueva factura es el flujo).
- Cambios de backend, schemas o acciones (cero cambios fuera del cliente).
- E2E nuevo (pausado por el usuario); verificación = typecheck + vitest full.

## Constraints
- Cero cambios de comportamiento salvo los 3 fixes (misma data a las actions).
- Hoja en paleta papel fija (blanca) en ambos temas: decisión deliberada de documento.
- Labels/selects/inputs conservan nombres accesibles (no romper specs).
- Convención: suite FULL; Conventional Commits español neutro; direct-inline (sin delegación en este runtime).

## Tasks
- [x] B1+B2+B3 fixes de emisión (route: direct-inline, mismo archivo) — commit 1181e13 + este
- [x] R1 crear como factura (route: direct-inline, 1 archivo conocido) — commit 1181e13
- [x] R2 detalle como factura (route: direct-inline, 1 archivo conocido)
- [x] VER full + push

## Authorized scope
Módulo facturación: fix bug reportado + rediseño de diálogos crear/detalle como documento. Rama `feat/orabella-mvp`, commits por unidad.

## Acceptance
- Clic en Emitir factura con datos válidos emite (notice + abre detalle); con datos inválidos el error se VE dentro del diálogo.
- Un throw en la action no deja el botón pegado (try/finally).
- Crear y detalle se ven como factura (encabezado, tabla, totales); totales vivos cuadran con lo emitido.
- `npm run typecheck` 0; `npm test` sin regresiones.

## Checks
`npm run typecheck`, `npm test` (full).

## Progress
- 2026-09-22: diagnóstico (botón fuera del form). Doc creado.

## Verification evidence
- `npm run typecheck`: 0 errores. `npx eslint` en tocados: limpio. `npm test`: 183/183.
- Ajuste de alcance honesto: `billing/service.ts` suma `no_commission` al SELECT del detalle + tipo (2 líneas) para mostrar el flag; sin eso el toggle no se vería.
- Sin E2E nuevo (pausado por el usuario): la prueba de emitir queda manual.

## Next step
- B1+B2+B3, luego R1, R2, VER y push.

## Route declaration
- Direct-inline (delegación imposible en este runtime). Sin SDD.
