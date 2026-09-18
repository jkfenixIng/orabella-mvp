# Módulo `auth` (T2 — implementado)

Login con número de documento, clave inicial = documento con cambio forzado
(AUTH-01), cambio de clave propia (AUTH-02), sesiones con expiración /
revocación / timeout de inactividad (AUTH-03), alta solo por admin
(AUTH-04), bloqueo tras 5 intentos (AUTH-05), recuperación con token de un
solo uso y expiración de 30 min (AUTH-06), 3 roles fijos sin granularidad
(AUTH-07). RLS deny-by-default; políticas por sede en T3.

- Tablas (migración `002_auth.sql`): `users`, `roles` (seed
  admin/empleado/caja), `user_roles`, `sessions`, `password_resets`.
- PRD: §5.1 AUTH-01…07, §9 (users/roles/user_roles/sessions/password_resets),
  §10 Auth API-first, plan paso 1 (§12).

## Decisión de credenciales (vía única)

**Fuente de verdad: `users.password_hash` (scrypt, servidor).** El login por
documento se verifica contra esa columna con `service_role` en servidor.

Supabase Auth **no** es la vía de login del MVP: exigiría un email por
usuario y no hay emails sintéticos (`id@orabella.local` prohibido). Como hay
usuarios que solo tienen documento, `adminCreateUser` exige correo **real** y
además espeja el alta en Supabase Auth Admin (`email` + `user_metadata` con
`id_number`) para la futura autenticación JWT/RLS. Si el espejo falla, el alta
se revierte (compensación en `adminCreateUser`).

Consecuencias:

- `users.email` es UNIQUE pero nullable en BD (usuarios legacy
  solo-documento); el esquema `adminCreateUser` lo exige en T2.
- `users.sede_id` es nullable en T2 (FK futura a `sedes`, la crea T3).
- Sin login social ni MFA en el MVP.

## Endpoints (REST API-first, validación Zod en servidor)

Base `/api/v1/auth` (un catch-all `[...action]`; acepta `:` y alias `/` porque
NTFS no permite carpetas con `:` en disco):

| Método + path | Servicio | Auth |
|---|---|---|
| `POST /api/v1/auth/login` | `loginWithDocument` | Público + rate-limit |
| `POST /api/v1/auth/logout` | `logoutWithToken` | Sesión |
| `POST /api/v1/auth/password:change` | `changeUserPassword` | Sesión |
| `POST /api/v1/auth/password-reset:request` | `requestPasswordReset` | Público + rate-limit |
| `POST /api/v1/auth/password-reset:confirm` | `confirmPasswordReset` | Público (token) |

Respuestas con `ok()`/`fail()` (`{success, data}` / `{success:false, code,
message}`). `login` responde `{must_change_password, user:{id, full_name,
roles}}` y fija la cookie httpOnly `orabella_session`.

Las Server Actions (`actions.ts`: `loginAction`, `logoutAction`,
`changePasswordAction`, `requestResetAction`, `confirmResetAction`,
`adminCreateUserAction`) usan el **mismo servicio** y validación.

## Reglas implementadas

- Rate-limit en memoria: 5 intentos / 15 min por documento
  (`DocumentRateLimiter`, compartido por routes + actions). Nota serverless:
  es local al proceso; en multi-instancia se endurece con store externo (T7).
- Bloqueo: al 5.º fallo `failed_attempts=5` y `locked_until=now+15min`;
  dentro del bloqueo se rechaza aunque la clave sea correcta (423).
- Errores genéricos en login (`Documento o clave inválidos.`): no revelan si
  el documento existe. `requestReset` siempre responde `{requested:true}`.
- Sesión: token opaco (SHA-256 en BD), TTL 12 h, inactividad 30 min
  (`last_activity_at` se refresca en `getSessionUser`), revocación en logout /
  cambio de clave (mantiene la actual) / reset confirmado.
- Recuperación: token de un solo uso (`used`, `expires_at=created+30min`,
  `CHECK(expires_at>created_at)`). Sin mailer en T2: en no-producción la
  respuesta incluye `dev_token` para pruebas manuales.
- Política mínima de clave: 8+ caracteres con letra y número (servidor).
- Middleware (`middleware.ts`): puerta gruesa — todo exige cookie salvo
  `/login`, `/api/v1/health` y `/api/v1/auth/*`. La validez fina la verifica
  `getSessionUser()` contra BD en cada request.
- UI mínima (`/login`): form documento+clave, error genérico, flujo de cambio
  forzado inline (AUTH-01).

## Tests

`tests/auth.test.ts` (vitest, unit, sin red): esquemas Zod, rate-limit
(bloqueo al 5.º, expiración de ventana, aislamiento por documento, reset),
bloqueo `locked_until`, validez de sesión (ok/expirada/revocada/inactiva),
un solo uso y expiración del reset, y roundtrip scrypt.
