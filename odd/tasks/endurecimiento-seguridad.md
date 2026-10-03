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

> **Corrección de 2026-10-02.** Ese segundo renglón ya no está en el código:
> `resolveSede` se eliminó de `src/shared/lib/sede.ts` con la retirada de sede única.
> El patrón de la casa hoy es la guarda de sesión más `requireSedeRole`, que
> autoriza por **ROL**. Ninguna action ni ninguna ruta compara sedes, porque la
> instalación es de una sola y la comparación no acotaba nada. El bloque de arriba
> se conserva como la foto de 2026-09-28, la fecha en que se verificó F1.

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
- [x] W2 Cabeceras de seguridad en `next.config.ts` + test — `23cfb54`. Verificadas **en vuelo** con `next start` + `curl`: las cuatro salen con el valor exacto en respuestas 200, en el 307 del middleware y en los 401 de la API.
- [x] W3 Endurecer el invariante y los tests de cabeceras — `fa74bb3`. Los 3 huecos de arriba quedaron cerrados; la verificación adversarial encontró 6 mecanismos de bypass nuevos, ninguno activo hoy (detalle abajo).
- [ ] W4 (el usuario canceló la decisión: **no se toca el test**) Arreglar la regla de orden. Detalle abajo, queda como deuda conocida.
- [ ] Consolidar el informe de las dimensiones de auditoría (S1–S5) con plan priorizado

## W1 — resultado y deuda residual (verificación independiente, 2026-10-01)
Gate: `npm run test` 359/359 · `tsc --noEmit` limpio · `eslint` (1 warning pre-existente en `app/error.tsx`, archivo ajeno al cambio) · `next build` compilado, 22/22 páginas.

La guarda se verificó **no bypasseable**: el token sale de la cookie httpOnly y no de ningún parámetro declarado en el input, así que ningún argumento del cliente influye en la autorización; `requireAdminSession` es la primera posibilidad de fallo, antes de cualquier mutación; `requireAdminSession` lanza `NO_SEDE` si la sede es nula, así que `session.sedeId` nunca es nulo. La identidad de `AdminError` se confirmó como **valor re-exportado único** (`shared/lib/sede.ts` declara `SedeError` una sola vez; `admin/service.ts` lo re-exporta como alias), así que el `instanceof` no cae en silencio a `INTERNAL`.

Divergencia de diseño observada, **no un agujero**: esta action reescribe `sede_id` en silencio, mientras el resto del código usa `resolveSede`, que lanza FORBIDDEN ante una sede ajena (~40 sitios). Falla cerrado, pero oculta un bug del cliente en lugar de rechazarlo.

**Estado de esa divergencia (2026-10-02): desapareció con la función.** `resolveSede` ya no existe, así que los ~40 sitios de llamada que aquí se contaban son hoy cero. La action sigue estampando `sede_id` desde la sesión, pero ya no oculta un bug del cliente: no hay sede ajena que rechazar, y la columna dejó de autorizar nada del negocio. La defensa real quedó en las guardas de ROL y en los filtros de cada consulta.

### Huecos residuales del test de invariante (candidatos a W3)
1. La allowlist se indexa por **nombre** de función, no por (archivo, nombre), y la unicidad no se verifica. Una action nueva sin guarda que reutilice `loginAction` / `logoutAction` / `requestResetAction` / `confirmResetAction` se saltea el filtro: el test "debe vivir en auth" usa el primer match y `auth` ordena antes que el resto, así que el duplicado queda sombreado y el test igual pasa.
2. `GUARD_RE` es un chequeo de **presencia de token**, no de orden ni de efectividad: matchea dentro de comentarios y strings, acepta cualquier `requireAlgo(` que no sea guarda de autorización, y **no verifica que la guarda corra antes de la mutación**. Una action que mute y recién después llame `requireAdminSession` pasaría — que es justo la próxima forma del bug que este test existe para prevenir.
3. Las formas de export que no son `function` son invisibles (`export const x = async () => {}`, `export { x } from ...`, `export default`), y el piso de 50 acciones tolera perder hasta 17 en silencio.

Fuera de alcance por diseño: los route handlers REST de `app/api/**/route.ts` también alcanzan `service_role` y este invariante no los cubre.

## W3 — resultado y deuda residual (verificación adversarial, 2026-10-01)
Commit `fa74bb3`. Gate: `npm run test` 376/376 (baseline 363) · `tsc --noEmit` · `eslint` (1 warning pre-existente) · `next build`. Ningún archivo de `src/` fue tocado.

Cerrado de verdad: la allowlist pasó a `(archivo, nombre)` con tests de no-uso, declaración única y módulo correcto; el limpiador de comentarios y literales evita el match dentro de texto; se exige forma de declaración de función en todo export; y los dos tests de omisión de cabeceras ahora afirman primero la precondición positiva, así que vaciar o renombrar los headers ya no pasa vacío.

**Corrección al auto-reporte del writer:** la regla de orden evalúa **63** actions, no 67. Las 4 públicas de auth están exentas, y la exención es correcta: no pueden exigir sesión porque su trabajo es crearla o recuperarla.

### La regla de orden: 6 mecanismos de bypass, ninguno activo hoy
Verificados con arnés propio fuera del repo. Hoy no dispara ninguno porque las 63 actions tienen como primera llamada a `service` una guarda que **lanza** excepción, y la coincidencia crudo-vs-limpiado dio 63/63 sin discrepancias.

1. **Guarda cuya falla se descarta**: `try { await requireSession(...) } catch {}` y después mutar. Verde total. Es el falso verde futuro más probable.
2. **`getSessionUser(...)` con el resultado ignorado**: devuelve `null` en lugar de lanzar, pero satisface el regex; ya está importado de `./service`. Su único call site hoy sí valida.
3. **Token `require*` que no es guarda** (`requireSedeRole` sirve) o mutar por fuera de `service`: verde total. La regla no mira procedencia.
4. **Import mutador re-ruteado fuera de `./service`**: barrel `./service/index`, `default + * as`, dos imports en una línea, `await import()`.
5. **Confusión del limpiador con un regex literal** (`/a\/*/`): demostrado. Mete el limpiador en modo comentario y borra la mutación.
6. **Guarda diferida** (`const authorize = () => requireSession(...)` antes del mutate): verde. Compara offsets textuales, no orden de ejecución.

### Proporcionalidad: veredicto del verificador
El archivo tiene **802 líneas**, de las cuales **~500 son un lexer hecho a mano** que reimplementa peor lo que `oxc` y `typescript` — ya instalados — dan gratis. Es más código que varios de los módulos que vigila.

**Las limitaciones documentadas del archivo NO conceden los casos 1 y 2**, que son falsos verdes completos: el test afirma más cobertura de la que tiene. Eso es peor que no tenerlo, porque da confianza falsa. Además el ejemplo de regex que documenta (`/a//b/`) no es TypeScript válido, así que ni el ejemplo sirve.

**Riesgo de falso positivo, no hipotético:** `sessionToken()` es un helper local en 7 de los 8 módulos. Si se mueve a `auth/service.ts` — su casa natural, al lado de `SESSION_COOKIE_NAME` — el idiom `const token = await sessionToken(); const s = await requireSession(token)` pasa a leerse como "muta antes de autorizar" en **todas** las actions de todos los módulos: un muro de rojo por un refactor que no empeora nada. La causa de fondo es que la regla **no tiene modelo de lectura/escritura** y no distingue `listEmployees()` de `deleteCommissionRule()`.

W4 propuesto: allow-list de imports de plomería (`sessionToken` y similares), conceder los casos 1 y 2 en las limitaciones documentadas, borrar la regla de export (redundante con `next build`) y corregir el ejemplo de regex inválido. **El usuario canceló la decisión, así que el test no se toca**: queda registrado como deuda conocida y ningún guardia se debilita por accidente.

## Estado
- 2026-09-28: creado. Auditoría S1 completa (14 hallazgos, F1 verificado por el orquestador). S2/S3/S4 en curso. Lote autorizado por el usuario ("aplica lo que se pueda") bajo la restricción de cero sobrecostos de infraestructura y cero límites a las pruebas.
- 2026-10-01: W2 (`23cfb54`) y W3 (`fa74bb3`) commiteados, gate verde en ambos. El linaje `review-91c57d3fbc9f6a7b` quedó **cerrado** con la operación auditada `review abandon` (`reason: operator_disposition`, registro en `.git/gentle-ai/review-transactions/quarantine/`); no se descartó trabajo: cero resultados de lente, cero hallazgos. Tras un `abandon` commiteado corresponde un `inspect` antes de cualquier START nuevo.
- 2026-10-01: lote de estilos auditado (S5). Hallazgo verificado por el orquestador: los cuatro tokens `-50` en tema claro tienen chroma 0, así que `.bg-*-light` pinta el mismo gris casi blanco y todo badge sale gris en claro y con color en oscuro. WU0 en curso: dar croma a los `-50` y cablear los aliases canónicos de shadcn.
- 2026-10-02: corregidos los dos puntos de este documento que trataban a `resolveSede` como frontera vigente — el bloque de patrón de casa y la divergencia de `adminCreateUserAction`. El texto original de ambos se conserva; lo que dejó de describir el código es la función. El cierre de la retirada de sede única está en `odd/tasks/plataforma-super-admin.md`. F1–F14 y su estado no cambian.
