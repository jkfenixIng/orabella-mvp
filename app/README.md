# Orabella MVP — app web (rebuild total)

Next.js 15 App Router + React 19 + TypeScript estricto + Tailwind CSS 4 +
next-themes + Zod 4 + Supabase JS v2 + vitest. Monolito modular por features,
API-first (`/api/v1`) para la futura app. Verdad funcional: `PRD_Orabella_MVP.md`
en la raíz del repo. **No tocar `API/` ni `front/`** (stack anterior).

## Requisitos

- Node.js >= 20 y npm >= 10.
- Proyecto **nuevo** de Supabase (NO reutilizar la base actual).

## Env

Copiar `.env.example` a `.env.local` y completar. Las dos variables de Upstash
son opcionales y no vienen en `.env.example`: se leen directo de `process.env`
en `src/shared/lib/rate-limit.ts`.

| Variable | Alcance | Notas |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | pública | URL del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | pública | anon key (siempre bajo RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | **solo servidor** | jamás prefijo `NEXT_PUBLIC_`, jamás en cliente; solo vía `createAdminClient()` |
| `UPSTASH_REDIS_REST_URL` | solo servidor (opcional) | rate-limit externo; sin ella hay fallback a memoria con advertencia |
| `UPSTASH_REDIS_REST_TOKEN` | solo servidor (opcional) | par de la anterior; nunca prefijo `NEXT_PUBLIC_` |

## Comandos

```bash
npm install     # instalar dependencias
npm run dev     # desarrollo (http://localhost:3000)
npm run build   # build de producción
npm start       # servir build de producción
npm run typecheck  # tsc --noEmit
npm run lint    # eslint .
npm test        # vitest run
```

## Estructura

```text
app/                      # App Router (layout, page, globals.css, api/v1/*)
src/features/{admin,alerts,auth,billing,cash,commissions,inventory,payroll}/  # un módulo por feature, con README propio
src/shared/{components,lib,config}/  # theme, api-response, supabase client/server, audit, rate-limit, env
supabase/migrations/      # SQL versionado (001 fundación; dominio en T2→T7; endurecimiento en T8; 009→031 ampliaciones)
supabase/seeds/           # seeds de aceptación §11 (T8, idempotentes)
tests/                    # suites vitest + e2e Playwright (tests/e2e/)
```

## Convenciones

- **Modo oscuro sin flash (NFR-06):** `ThemeProvider` (`attribute="class"`) +
  cookie `orabella-theme` leída en SSR (clase inicial en `<html>`) + script
  inline bloqueante (`beforeInteractive`) que fija la clase antes del paint +
  `suppressHydrationWarning` + variables CSS (`@custom-variant dark` en Tailwind 4).
- **Zona horaria de presentación (D5, decisión: dejarlo como está):** el
  cálculo de negocio usa America/Bogota (`src/shared/lib/dates.ts`), pero lo que
  se **muestra** en pantalla sale del reloj del navegador: `formatDateTime`
  (`src/shared/lib/format.ts`) llama a `toLocaleString` sin `timeZone`. Un
  usuario con la máquina en otro huso ve las horas corridas, sin error ni aviso.
  Se revisó y se dejó así a propósito (una sola sede, personal en Colombia, y
  fijarlo cambiaría la fecha y hora de todas las pantallas ya aceptadas); el
  punto único si algún día se fija es esa función. No es un olvido.
- **API-first (§10):** lógica en servicios del servidor; web vía Server Actions,
  futura app vía REST `/api/v1` (hoy todas las rutas autentican con la cookie
  de sesión `orabella_session`, no con JWT de Supabase; errores
  `{success:false, code, message}`).
- **Seguridad:** RLS deny-by-default por `sede_id`; `service_role` solo en servidor;
  validación Zod server-side en toda escritura.
- **Migraciones:** `supabase/migrations/NNN_*.sql`, `001_foundation.sql` solo trae
  `pgcrypto` + trigger `set_updated_at()` (sin tablas de dominio). Aplicar en
  orden `001 → 031` en un proyecto Supabase **nuevo**; luego
  `supabase/seeds/acceptance.sql` (idempotente, datos ficticios §11).
  Tras T8 (001→008) la numeración continúa con endurecimiento (017/018),
  control de caja (009/010), alertas (011–014), comisiones (016/020/027/030) y
  ajustes de admin, factura y vales (015, 019, 021–026, 028, 029, 031).

## Seguridad (T8 — endurecimiento)

### Postura real (D8): RLS está FUERA del modelo de amenaza

Escrito para que nadie cuente con una segunda línea de defensa que no existe.

- **La app nunca ejecuta una consulta bajo RLS.** El único cliente que importa
  una feature es `createAdminClient()` (`src/shared/lib/supabase/server.ts:47`),
  que se construye con `SUPABASE_SERVICE_ROLE_KEY` (`:49`, `:56`) — la clave
  `service_role`, que **bypasea RLS por diseño**. Lo usan los ocho servicios de
  feature (`src/features/admin/service.ts:48`, `alerts/service.ts:32`,
  `auth/service.ts:241`, `billing/service.ts:74`, `cash/service.ts:75`,
  `commissions/service.ts:36`, `inventory/service.ts:39`,
  `payroll/service.ts:79`) y `src/shared/lib/audit.ts:83`.
- **Los dos clientes con RLS son código muerto.** `createClient()` de
  `src/shared/lib/supabase/server.ts:20` (anon key + cookies de la request) y
  `createClient()` de `src/shared/lib/supabase/client.ts:15` (navegador, anon
  key) están exportados y **no los importa nadie**: 0 importadores. No se borran
  —siguen siendo el camino correcto si algún día se migra la app a RLS— pero hoy
  no protegen nada. **No los cuentes como barrera.**
- **La ÚNICA barrera real es el código de aplicación:** `resolveSede()`
  (`src/shared/lib/sede.ts:46`), `requireSedeRole()` (`:35`) y los filtros
  `sede_id` que cada servicio aplica a mano antes de consultar. Un guard
  olvidado es una brecha total, no un agujero parcial: no hay nada detrás.
- **Qué escriben las migraciones (dato, no protección).** Los bullets de abajo
  describen el esquema, y el esquema sí trae aislamiento por sede:
  `008_hardening.sql:147-166` revoca las 20 políticas `USING (true)` de T2–T7 y
  `:174-368` las reemplaza por políticas con `public.current_sede_id()`; y
  `017_hardening_round2.sql:55-66` cierra las dos que
  `016_commissions.sql:100-103` había dejado abiertas. Queda un `USING (true)`
  deliberado y documentado: `008_hardening.sql:382-384` (`public.roles`, catálogo
  global de 3 filas, solo `SELECT`). Aun así **no es una defensa activa**: como
  el tráfico de la app va con `service_role`, RLS no se evalúa nunca.
- **Lo que NO se puede verificar desde el repo:** qué migraciones están aplicadas
  en el proyecto Supabase desplegado. Se aplican a mano (este README pide
  `001 → 031` y la numeración llega a `034`) y no hay `supabase/config.toml`, así
  que el estado real de las políticas se comprueba en la base, no acá.

- **RLS por sede con claim JWT:** la migración `008_hardening.sql` revoca las
  20 políticas permisivas temporales (`USING true`) de T2–T7 y crea políticas
  por sede con `public.current_sede_id()`, que lee
  `auth.jwt() -> 'app_metadata' ->> 'sede_id'`. Sin claim no hay filas
  (deny-by-default, NFR-02); `service_role` hace bypass natural en servidor.
- **Auth Hook (custom access token):** en Dashboard > Authentication > Hooks >
  "Customize Access Token", habilitar apuntando a la función documentada en el
  encabezado de `008_hardening.sql` (`public.custom_access_token_hook`): al
  login setea `app_metadata.sede_id` desde `users.sede_id`.
- **Auditoría:** `audit_logs` (TRA-01) + `src/shared/lib/audit.ts`
  (`writeAudit()` con service_role, nunca en cliente). Acciones
  (`AUDIT_ACTIONS` en ese archivo): login fallido/bloqueo, cambio de clave,
  creación/edición/anulación de factura, turnos de caja (apertura, cierre con
  o sin desajuste, edición), base de caja, cálculo/cierre/eliminación de
  nómina, pago de comisión y vales (solicitado, aprobado, rechazado).
- **Rate-limit:** `src/shared/lib/rate-limit.ts` — Upstash Redis REST cuando
  existen `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` (5 intentos /
  15 min por documento en login y password-reset); sin ellas, fallback a
  memoria con advertencia en log (no válido en multi-instancia).
- **Excepciones funcionales:** `roles` es catálogo global de lectura
  (`pol_roles_readonly`); tablas sin `sede_id` filtran por el padre
  (factura, periodo, usuario). Detalle en `008_hardening.sql`.

## Orden de construcción (T1 → T8)

1. **T1** scaffold + fundación (este README, layout, health, vitest). ✅
2. **T2** auth (AUTH-01…07) → 3. **T3** admin (ADM-01…08) → 4. **T4** inventario
   (INV-01…05) → 5. **T5** factura interna (FAC-01…07) → 6. **T6** caja multi-turno
   (CAJ-01…06) → 7. **T7** nómina/vales (PAY-01…07 + TRA-01…03) →
   8. **T8** endurecimiento (RLS JWT + auditoría + rate-limit + aceptación §11). ✅
