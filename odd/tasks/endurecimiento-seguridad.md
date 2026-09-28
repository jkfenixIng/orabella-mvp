# Endurecimiento de seguridad: autorización de acciones de servidor y cabeceras

## Objective
Cerrar los hallazgos de la auditoría de seguridad (S1, 2026-09-28, rama `feat/orabella-mvp`) que se pueden corregir **sin costo de infraestructura y sin limitar la ejecución de pruebas**, tal como lo instruyó el usuario. Los hallazgos que exigen un servicio pago/metered, o que traban tests funcionales/e2e, quedan explícitamente diferidos con su motivo.

## Problem
La auditoría read-only de `app/` reportó 14 hallazgos. El crítico y verificado por lectura directa:

**F1 (critica) — `adminCreateUserAction` no tiene control de autorización.**
`app/src/features/auth/actions.ts:1` es `"use server"`, así que cada export es un endpoint HTTP POST alcanzable por cualquier usuario logueado, sin importar su rol. La función en la línea 112 llama `adminCreateUser(input)` sin ninguna guarda, mientras su hermano inmediato `adminResetPasswordAction` (línea 137) sí llama `requireAdminSession`. El comentario del propio autor admite la deuda: *"esta action asume que el llamante ya verificó el rol (la verificación por rol/sede la cierra T3 con requireSedeRole)"* — esa T3 nunca cerró. Como la capa de datos usa `createAdminClient()` (Supabase `service_role`), que **bypasea RLS**, no existe segunda línea de defensa.

Cadena de explotación: un usuario de rol `caja` o `empleado` POSTea la action con `roles: ["admin"]`; el servicio siembra `password_hash = hashPassword(documento)` (`service.ts:604`) y espeja el usuario en Supabase Auth; el atacante entra como admin con la clave que él mismo eligió.

Verificación de aislamiento (hecha por el orquestador, no reportada por el subagente): al enumerar las guardas de los 8 módulos `src/features/*/actions.ts`, **`adminCreateUserAction` es el único outlier**. Los otros 7 módulos aplican el patrón de la casa de forma consistente:

```ts
const session = await require<X>(await sessionToken());
// ...
resolveSede(session.sedeId, <sede solicitada>)
```

**Consecuencia de diseño del test:** un test de invariante que exija guarda en toda action exportada **nace verde y se pone rojo únicamente por F1**. Es un test de regresión legítimo y no un test acomodado al bug.

Wart secundario detectado en el mismo archivo: `toFailure` (`actions.ts:31-37`) solo reconoce `AuthError`, así que las guardas hermanas que lanzan `AdminError`/`SedeError` colapsan a `code: "INTERNAL"` en vez de reportar `UNAUTHENTICATED`/`FORBIDDEN`. La guarda bloquea igual, pero el código de error miente.

## Why
F1 es escalación de privilegios remota a admin desde cualquier sesión de bajo privilegio, en un monolito ya desplegado. Es el hallazgo de mayor impacto de la auditoría y su corrección es de una línea, sin costo y sin efecto sobre las pruebas existentes (verificado: `tests/` no referencia `dev_token`, ni el 403 de sede, ni `features/auth/actions`).

## Scope
Work units de este lote (2):

### W1 — Autorización de acciones de servidor (F1 + invariante de clase)
- `app/src/features/auth/actions.ts` — guardar `adminCreateUserAction` con `requireAdminSession`, forzar `sede_id: session.sedeId` sin confiar en el cliente, y corregir `toFailure` para que las guardas reporten su código real.
- `app/tests/action-guards.test.ts` (nuevo) — invariante estructural: toda action exportada en `src/features/*/actions.ts` debe llamar una guarda de autorización, salvo lista blanca explícita y comentada de actions legítimamente públicas. Sigue el patrón de la casa de tests que leen archivos reales (`hardening.test.ts` lee el SQL, `design-tokens.test.ts` lee el CSS).

### W2 — Cabeceras de seguridad (F9)
- `app/next.config.ts` — `headers()` con `Strict-Transport-Security`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-DNS-Prefetch-Control`.
- `app/tests/security-headers.test.ts` (nuevo) — afirma que la config declara esas cabeceras.

Sin CSP estricta en este lote: una CSP mal calibrada rompería la app y los e2e, lo que choca con la restricción de no limitar pruebas.

## Fuera de alcance, con motivo (diferido, requiere decisión del usuario)
| Hallazgo | Motivo de exclusión |
| --- | --- |
| F3 — hacer obligatorio un rate limiter externo en producción | **Sobrecosto**: exige Upstash Redis o equivalente. Además el reporte original sobreestima el riesgo: el bloqueo por cuenta (`locked_until`) es estado en BD, por lo que **sí funciona entre instancias**; lo que se pierde sin store compartido es solo el conteo de requests por isolate. |
| F2 — cuotas en los 30 endpoints de negocio | **Sobrecosto / riesgo de datos**: requiere store compartido. La alternativa gratis (tabla en BD) escribe en cada request. Decisión pendiente. |
| F6 — forzar `must_change_password` en el servidor | **Limita pruebas**: bloquearía usuarios sembrados en e2e/flujos funcionales. Decisión pendiente. |
| F7 — visibilidad de facturas por rol (la API es más laxa que la UI) | **Decisión de producto**: ¿un `empleado` ve solo sus facturas o todas las de la sede? UI y API se contradicen hoy. |
| F5 — política de bloqueo/enumeración en login | **Decisión de producto**: lockout duro vs backoff exponencial vs CAPTCHA. |
| F12 — prefijo `__Host-` en la cookie de sesión | **Limita pruebas**: rompe `tests/e2e/.auth/user.json`, que fija `orabella_session`. |
| F11 — `dev_token` de reset devuelto fuera de producción | **Limita pruebas**: el usuario puede estar usándolo en PRUEBAS como conveniencia. Requiere confirmación. |
| F8 — `setUserRoles` sin alcance de sede | Latente (MVP mono-sede). Requiere confirmar antes la semántica de admin global / `sede_id` nulo. |
| F4 — choke point de autorización (`withAuth`) | Refactor estructural de riesgo medio; su parte barata y de mayor valor (test de enumeración) se absorbe en W1. |
| F10, F13, F14 | Bajo impacto o arquitectónico (RLS como defensa en profundidad). Registrados, no accionados. |

Higiene registrada aparte: falta `.gitattributes` (git avisa `LF will be replaced by CRLF` en cada archivo, o sea los bytes commiteados no coinciden con el working tree) y `.codegraph/` + `.gentle-ai-default-agent.json` no están en `.gitignore`.

## Tasks
- [x] W1 Autorización de acciones de servidor (F1 + test de invariante) — gate verde y evidencia rojo→verde real
- [ ] W2 Cabeceras de seguridad en `next.config.ts` + test
- [ ] W3 (propuesto) Endurecer el invariante de guardas: los 3 huecos residuales de abajo
- [ ] Consolidar el informe de las 4 dimensiones de auditoría (S1–S4) con plan priorizado

## W1 — resultado y deuda residual (verificación independiente, 2026-10-01)
Gate: `npm run test` 359/359 · `tsc --noEmit` limpio · `eslint` (1 warning pre-existente en `app/error.tsx`, archivo ajeno al cambio) · `next build` compilado, 22/22 páginas.

La guarda se verificó **no bypasseable**: el token sale de la cookie httpOnly y no de ningún parámetro declarado en el input, así que ningún argumento del cliente influye en la autorización; `requireAdminSession` es la primera posibilidad de fallo, antes de cualquier mutación; `requireAdminSession` lanza `NO_SEDE` si la sede es nula, así que `session.sedeId` nunca es nulo. La identidad de `AdminError` se confirmó como **valor re-exportado único** (`shared/lib/sede.ts` declara `SedeError` una sola vez; `admin/service.ts` lo re-exporta como alias), así que el `instanceof` no cae en silencio a `INTERNAL`.

Divergencia de diseño observada, **no un agujero**: esta action reescribe `sede_id` en silencio, mientras el resto del código usa `resolveSede`, que lanza FORBIDDEN ante una sede ajena (~40 sitios). Falla cerrado, pero oculta un bug del cliente en lugar de rechazarlo.

### Huecos residuales del test de invariante (candidatos a W3)
1. La allowlist se indexa por **nombre** de función, no por (archivo, nombre), y la unicidad no se verifica. Una action nueva sin guarda que reutilice `loginAction` / `logoutAction` / `requestResetAction` / `confirmResetAction` se saltea el filtro: el test "debe vivir en auth" usa el primer match y `auth` ordena antes que el resto, así que el duplicado queda sombreado y el test igual pasa.
2. `GUARD_RE` es un chequeo de **presencia de token**, no de orden ni de efectividad: matchea dentro de comentarios y strings, acepta cualquier `requireAlgo(` que no sea guarda de autorización, y **no verifica que la guarda corra antes de la mutación**. Una action que mute y recién después llame `requireAdminSession` pasaría — que es justo la próxima forma del bug que este test existe para prevenir.
3. Las formas de export que no son `function` son invisibles (`export const x = async () => {}`, `export { x } from ...`, `export default`), y el piso de 50 acciones tolera perder hasta 17 en silencio.

Fuera de alcance por diseño: los route handlers REST de `app/api/**/route.ts` también alcanzan `service_role` y este invariante no los cubre.

## Estado
- 2026-09-28: creado. Auditoría S1 completa (14 hallazgos, F1 verificado por el orquestador). S2/S3/S4 en curso. Lote autorizado por el usuario ("aplica lo que se pueda") bajo la restricción de cero sobrecostos de infraestructura y cero límites a las pruebas.
- 2026-10-01: W1 commiteado con gate verde. **Review nativo omitido por decisión explícita del usuario** (el switch RDD permite omitir cuando el usuario deja el candidato sin revisar). Quedó un linaje abierto, `review-91c57d3fbc9f6a7b`, en estado `reviewing`, sin capturar, sin autoridad consumida y sin mutación; limpiarlo requiere la operación auditada `abandon` con decisión explícita. Diferido.
