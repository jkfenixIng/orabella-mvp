# UX + E2E todos los flujos

## Objective
Dejar la UX funcionando bien en toda la app y cubrir todos los flujos con E2E smoke, sin refactors riesgosos antes de las pruebas funcionales F1-F4.

## Problem
- Las animaciones de Dialog/Select usan clases `animate-in/fade-in/zoom-in-95/...` del plugin `tailwindcss-animate`, que NO está instalado ni hay keyframes propios: las aperturas/cierres no animan (clases muertas).
- Sin regla `prefers-reduced-motion`: transiciones de 200ms corren aunque el usuario pida reducir movimiento.
- Login sin `required` en documento/clave: el submit vacío viaja al servidor en vez de frenarse en el navegador.
- E2E cubre solo `/login` render; los otros 7 flujos no tienen smoke.

## Why
La auditoría read-only mostró base sólida (guards consistentes, skeletons, empty states, `role=alert/status`, busy/disabled, tablas con scroll, nav móvil+sidebar, sin `alert()` ni `console.log`). Estos 4 puntos son los gaps reales y verificables que quedan.

## Scope
Touched:
- `app/src/components/ui/lib/dialog.tsx` (transiciones por estado Radix con utilidades core)
- `app/src/components/ui/lib/select.tsx` (idem, 1 bloque)
- `app/app/globals.css` (bloque `prefers-reduced-motion`)
- `app/app/login/login-form.tsx` (`required` en 2 inputs)
- `app/tests/e2e/guards.spec.ts` (8 rutas → `/login?next=...`) (nuevo)
- `app/tests/e2e/api.spec.ts` (health 200 + products 401) (nuevo)
- `app/tests/e2e/notfound.spec.ts` (404) (nuevo)
- `app/tests/e2e/login.spec.ts` (form + required + submit vacío bloqueado) (nuevo)
- Este documento + mirror Engram
Out:
- Login válido E2E (requiere seed aplicado + cambio forzado de clave: queda a F1-F4 manuales).
- Suite E2E autenticada completa (requiere backend de pruebas dedicado).
- Split de admin/service (diferido a post-pruebas, decisión registrada).
- Cambios visuales de diseño (colores, layout): no pedidos, no se tocan.

## Constraints
- Solo utilidades core de Tailwind (sin plugins nuevos).
- Zod en servidor sigue mandando; `required` es ayuda visual.
- Convención vigente: suite FULL siempre (`npm test` + `typecheck`); seccionado solo si se vuelve lenta.
- Conventional Commits en español neutro técnico, sin atribución IA.
- Delegación no disponible en este runtime; inline secuencial con constancia.

## Tasks
- [x] UX1 transiciones Dialog/Select por estado (route: direct-inline, 2 archivos conocidos) — commit 765f58f
- [x] UX2 `prefers-reduced-motion` global (route: direct-inline, 1 bloque CSS) — commit f6c5feb
- [x] UX3 `required` en login (route: direct-inline, 2 inputs) — commit f6c5feb
- [x] E2E1 guards de los 8 flujos (route: direct-inline, 1 spec nuevo)
- [x] E2E2 api health+401 (route: direct-inline, 1 spec nuevo)
- [x] E2E3 not-found + login form (route: direct-inline, 2 specs nuevos)
- [x] VER full (`typecheck` + `npm test` + `npx playwright test`) y push

## Authorized scope
Ajustes UX globales y por módulo que dejen todo funcionando + ampliar smoke a todos los flujos, sobre `feat/orabella-mvp` con commits por unidad.

## Acceptance
- Diálogos/selects abren/cierran con transición visible (opacity+scale por `data-state`).
- Con `prefers-reduced-motion`, no hay transiciones.
- Submit vacío en login no sale del `/login`.
- `npx playwright test`: todos los specs en verde (guards 8 rutas, api 2 casos, not-found, login).
- `npm run typecheck` 0 errores; `npm test` 183+ sin regresiones.

## Checks
`npm run typecheck`, `npm test` (full), `npx playwright test` (full).

## Progress
- 2026-09-22: auditoría read-only completa (guards, nav, tokens, tablas, alerts, iconos, animaciones). Doc creado.

## Verification evidence
- `npm run typecheck`: 0 errores.
- `npm test`: 11 archivos, 183/183 correctas.
- `npx playwright test`: 13/13 en verde (guards 8 rutas, api 2, smoke, login, not-found-redirige).
- Corrección honesta: ruta inexistente sin sesión redirige al login (middleware corre antes que el not-found); el 404 con sesión queda a F1-F4 manuales.

## Next step
- UX1 transiciones, luego UX2+UX3, specs E2E1-E2E3, VER y push.

## Route declaration
- Direct-inline por imposibilidad de delegación en este runtime (constancia, no omisión silenciosa). Sin SDD. Heurística ~400 líneas referencial.
