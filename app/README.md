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
src/shared/{components,lib,config}/  # theme, api-response, supabase client/server, env
supabase/migrations/      # SQL versionado (001 fundación; dominio en T2→T7)
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
  `pgcrypto` + trigger `set_updated_at()` (sin tablas de dominio).

## Orden de construcción (T1 → T7)

1. **T1** scaffold + fundación (este README, layout, health, vitest). ✅
2. **T2** auth (AUTH-01…07) → 3. **T3** admin (ADM-01…08) → 4. **T4** inventario
   (INV-01…05) → 5. **T5** factura interna (FAC-01…07) → 6. **T6** caja multi-turno
   (CAJ-01…06) → 7. **T7** nómina/vales (PAY-01…07 + TRA-01…03).
