# Ajustes skills 7 pre-pruebas

## Objective
Cerrar los 7 desajustes detectados en la revisión skills vs proyecto (memoria #470) para dejar el MVP listo para pruebas funcionales, sin refactors riesgosos antes de probar.

## Problem
- Sin boundaries `error.tsx` / `not-found.tsx`: un fallo de ruta rompe la app sin UI de recuperación.
- Sin `components.json`: stack ya es shadcn-compatible (radix + cva + clsx + tailwind-merge) pero sin config que lo declare.
- Diálogo de factura no expone `no_commission`: el schema y el backend lo soportan, pero la UI no lo envía, así que insumos (ej. tinte) siempre generan comisión.
- `admin/service.ts` (522 líneas) mezcla sesión + sedes + empleados + catálogos + pagos + roles; un split total ahora es riesgoso antes de pruebas.
- Sin Playwright E2E: solo vitest unitario; falta al menos un smoke E2E.
- Ruido de skill `dotnet-core-expert`: el repo es 100% Next.js, no aplica.

## Why
Las pruebas funcionales F1-F4 necesitan recuperación de errores, catálogos declarados, comisiones correctas por línea y un smoke E2E mínimo. El split grande de admin se difiere para no romper lo verificado (183/183 tests).

## Scope
Touched:
- `app/app/error.tsx` + `app/app/not-found.tsx` (nuevo)
- `app/components.json` (nuevo, mínimo compatible con `src/components/ui/lib/*`)
- `app/app/invoices/invoices-client.tsx` (ItemDraft + payload + checkbox sin comisión)
- `app/src/features/admin/service.ts` (solo comentarios delimitadores de dominio, sin mover lógica)
- `app/playwright.config.ts` + `app/tests/e2e/smoke.spec.ts` + script `test:e2e` (nuevo, sin descargar navegadores en este lote)
- Este documento + mirror Engram
Out:
- Split físico de admin/service en módulos (se difiere a post-pruebas).
- Instalación de navegadores Playwright y suite E2E completa.
- Facturación electrónica, multi-sede activa, agenda, reportes Excel, PWA.

## Constraints
- Zod en servidor manda; UI solo ayuda visual.
- Conventional Commits en español neutro técnico, sin atribución IA.
- No romper `npm run typecheck` ni `npm test`.
- Delegación a subagente no disponible en este runtime (free tier); implementación inline secuencial con commits por unidad de trabajo.

## Tasks
- [x] T1 error + not-found (route: direct-inline, trigger: ninguno, 2 archivos mecánicos ya comprendidos) — commit 18f66da
- [x] T2 components.json mínimo (route: direct-inline, 1 archivo mecánico) — commit f3a1f03
- [x] T3 toggle no_commission en factura (route: direct-inline, 1 archivo conocido + schema ya listo) — commit 879696a
- [x] T4 delimitación dominios admin/service con comentarios (route: direct-inline, sin mover lógica) — commit ec6631c
- [x] T5 playwright config + smoke spec + script (route: direct-inline, sin `npx playwright install` en este lote) — commit 2202600
- [x] T6 decisión dotnet-core-expert no aplica (solo registro, sin código)
- [x] VER typecheck + vitest + build rápido

## Authorized scope
Push de 5 commits a `feat/orabella-mvp` ya ejecutado (e74781f..5997a5d). Este lote implementa los 7 ajustes sobre la misma rama con commits por unidad.

## Acceptance
- `app/app/error.tsx` y `not-found.tsx` existen y compilan.
- `components.json` declara style, paths y baseColor compatibles con `src/components/ui/lib`.
- Crear factura con checkbox "Sin comisión" persiste `no_commission=true`; nómina la excluye (ya lo hace).
- `admin/service.ts` conserva 100% de lógica; solo suma encabezados de dominio.
- `npx playwright test --list` enumera el smoke sin exigir navegadores instalados.
- `npm run typecheck` 0 errores; `npm test` sin regresiones.

## Checks
`npm run typecheck`, `npm test`, `next build` (si tiempo lo permite), `npx playwright test --list`.

## Progress
- 2026-09-22: push 5 commits a origin/feat/orabella-mvp (e74781f..5997a5d). Doc creado. Delegación imposible (free tier), se sigue inline.

## Verification evidence
- `npm run typecheck`: 0 errores.
- `npm test`: 11 archivos, 183/183 pruebas correctas.
- `npx playwright test --list`: 1 test en 1 archivo (smoke login).
- `npx playwright test` (2026-09-22, Chromium instalado): 1 passed, smoke login muestra formulario (42.2s). Warnings de webpack PackFileCacheStrategy al arrancar dev son benignos.
- T6 dotnet-core-expert: sin código, repo 100% Next.js; skill no aplica, solo registro.
- ARQ1 (punto 1 de los 7): ya resuelto en 5997a5d, verificado sin imports cruzados de sede pendientes.

## Next step
- T1 error + not-found, luego T2-T5 en orden, VER al cierre.

## Route declaration
- General: direct-inline por imposibilidad de delegación en este runtime; se deja constancia en vez de delegación silenciosa omitida. Sin SDD: sin ambigüedad durable. Heurística ~400 líneas solo referencial; este lote es pequeño y coherente.
