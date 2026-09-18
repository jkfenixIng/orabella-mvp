# Orabella MVP — app web (rebuild total)

Next.js 15 App Router + React 19 + TypeScript estricto + Tailwind CSS 4 +
next-themes + Zod 4 + Supabase JS v2 + vitest. Monolito modular por features,
API-first (`/api/v1`) para la futura app. Verdad funcional: `PRD_Orabella_MVP.md`
en la raíz del repo. **No tocar `API/` ni `front/`** (stack anterior).

## Requisitos

- Node.js >= 20 y npm >= 10.
- Proyecto **nuevo** de Supabase (NO reutilizar la base actual).

## Env

Copiar `.env.example` a `.env.local` y completar:

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
src/features/{auth,admin,inventory,billing,cash,payroll}/  # un módulo por tarea T2→T7
src/shared/{components,lib,config}/  # theme, api-response, supabase client/server, audit, rate-limit, env
supabase/migrations/      # SQL versionado (001 fundación; dominio en T2→T7; endurecimiento en T8)
supabase/seeds/           # seeds de aceptación §11 (T8, idempotentes)
tests/                    # smoke tests vitest
```

## Convenciones

- **Modo oscuro sin flash (NFR-06):** `ThemeProvider` (`attribute="class"`) +
  cookie `orabella-theme` leída en SSR (clase inicial en `<html>`) + script
  inline bloqueante (`beforeInteractive`) que fija la clase antes del paint +
  `suppressHydrationWarning` + variables CSS (`@custom-variant dark` en Tailwind 4).
- **API-first (§10):** lógica en servicios del servidor; web vía Server Actions,
  futura app vía REST `/api/v1` (JWT Supabase, errores `{success:false, code, message}`).
- **Seguridad:** RLS deny-by-default por `sede_id`; `service_role` solo en servidor;
  validación Zod server-side en toda escritura.
- **Migraciones:** `supabase/migrations/NNN_*.sql`, `001_foundation.sql` solo trae
  `pgcrypto` + trigger `set_updated_at()` (sin tablas de dominio). Aplicar en
  orden `001 → 008` en un proyecto Supabase **nuevo**; luego
  `supabase/seeds/acceptance.sql` (idempotente, datos ficticios §11).

## Seguridad (T8 — endurecimiento)

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
  (`writeAudit()` con service_role, nunca en cliente). Acciones: login
  fallido/bloqueo, anulación de factura, cierre con base incompleta,
  cálculo/cierre de nómina, vales sobre tope, cambio de clave.
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
