# Orabella — MVP (app web)

**Orabella** es el sistema operativo de un negocio de belleza de **una sola
sede**: acceso por roles con el número de documento como usuario, administración
de empleados / servicios / impuestos / métodos de pago, inventario con kardex,
factura interna con consecutivo, caja multi-turno con arqueo, y el módulo
contable de nómina (fijo / porcentaje / mixto) con vales sujetos a topes y
aprobación.

Es una reconstrucción sobre plataforma gestionada: **Next.js 15 (App Router) +
React 19 + TypeScript estricto + Tailwind CSS 4 + next-themes + Zod 4 + Supabase
(Auth + Postgres) + vitest**, como monolito modular por *features* y API-first
(`/api/v1`) para una futura app cliente.

> **La raíz del repositorio es el proyecto.** `package.json`, `next.config.ts`,
> `middleware.ts`, el App Router (`app/`) y el código (`src/`) viven todos en la
> raíz. Todos los comandos se ejecutan desde la raíz, **no** desde `app/`.

---

## Estado y requisitos

| | |
|---|---|
| **Ámbito** | Una sola sede. Un solo despliegue (Vercel + Supabase). |
| **Node.js** | `>= 20` (`engines` en `package.json`). |
| **Paquetes** | npm (`package-lock.json`). |
| **Base de datos** | Un proyecto Supabase **nuevo**; no reutilizar una base existente. |
| **Cliente SQL** | `psql`, para aplicar el esquema y los seeds. |

---

## Inicio rápido

```bash
npm install
cp .env.example .env.local     # completar las 3 variables (ver Env)
npm run dev                    # http://localhost:3000
```

Base de datos, en este orden. El esquema se aplica **una sola vez**; los dos
seeds son idempotentes y se pueden reejecutar:

```bash
# apuntando al proyecto Supabase nuevo (connection string del dashboard)
psql "<connection-string>" -v ON_ERROR_STOP=1 --single-transaction -f supabase/migrations/001_orabella_schema.sql
psql "<connection-string>" -f supabase/seeds/catalog.sql      # catálogo mínimo: roles, sede, caja, pagos, impuestos, ajustes
psql "<connection-string>" -f supabase/seeds/acceptance.sql   # opcional: datos de prueba §11
```

El orden importa: `acceptance.sql` une contra `public.roles` por `code`, así que
sin `catalog.sql` la asignación de roles queda vacía. **La instalación no se
configura** (ver «La instalación no se configura»).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | desarrollo (`http://localhost:3000`) |
| `npm run build` | build de producción |
| `npm start` | sirve el build de producción |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint .` |
| `npm test` | vitest (`tests/**/*.test.ts`) |
| `npm run test:e2e` | Playwright (`tests/e2e/`) |
| `npm run test:e2e:changed` | Playwright con `--grep @changed` |
| `npm run test:e2e:full` | Playwright con `--grep @full` |

## Env

Copiar `.env.example` a `.env.local` y completar. Las dos variables de Upstash
son **opcionales** y no vienen en `.env.example`: se leen directo de
`process.env` en `src/shared/lib/rate-limit.ts`.

| Variable | Alcance | Notas |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | pública | URL del proyecto Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | pública | anon key (siempre bajo RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | **solo servidor** | jamás prefijo `NEXT_PUBLIC_`, jamás en cliente; solo vía `createAdminClient()` |
| `UPSTASH_REDIS_REST_URL` | solo servidor (opcional) | rate-limit externo; sin ella hay fallback a memoria con advertencia |
| `UPSTASH_REDIS_REST_TOKEN` | solo servidor (opcional) | par de la anterior; nunca prefijo `NEXT_PUBLIC_` |

Esta tabla es la lista completa de lo que hay que definir.

---

## Estructura del repositorio

```text
app/                          # App Router: layout, page, globals.css y api/v1/*
  api/v1/**                   # endpoints REST (auth, invoices, cash, cash-shifts,
                              #   payroll, vouchers, inventory, products, employees,
                              #   payment-methods, taxes, services, health)
src/
  features/{admin,alerts,auth,billing,cash,commissions,inventory,payroll}/
                              # un módulo por feature, cada uno con su README
  shared/lib/                 # supabase (client/server), audit, rate-limit, sede,
                              #   dates, format, money, paged, api-response, theme, env
  shared/components/          # app-shell, main-nav, theme-provider, theme-toggle, skeleton
  components/ui/              # primitivas de UI
  styles/design-tokens.css    # tokens de diseño
supabase/
  migrations/001_orabella_schema.sql   # EL esquema completo, en un solo archivo
  schema-history/             # la serie histórica 001–078 (explicación y respaldo)
  seeds/                      # catalog.sql, acceptance.sql, smoke.sql, test-invoices.sql
  squash/README.md            # procedimiento que regenera el archivo único
tests/                        # suites vitest (fuente en tests/**/*.test.ts)
  e2e/                        # specs Playwright + auth.setup.ts
docs/ux-ui-standard.md        # estándar de UX/UI
public/orabella-logo.png
middleware.ts                 # puerta gruesa de autenticación (presencia de la cookie)
```

El proyecto Next.js vive en la raíz; el App Router sigue llamándose `app/`:
`app/globals.css`, `app/layout.tsx` y `app/api/**` son las rutas y los estilos.

**Fuera del árbol versionado.** `.gitignore` deja fuera del repo los documentos
de origen (`PRD_Orabella_MVP.md`, `MVP_Orabella_Rebuild.docx`), los repos vecinos
del stack anterior (`API/`, `front/`) y material local (`odd/`, `entregables/`).
Siguen en disco, pero no son parte del repositorio ni objetivos de cambio.

---

## La instalación no se configura

**No hay cuenta de plataforma, ni pantalla `/plataforma`, ni comando que la
cree.** No es un pendiente: la capa que las tenía —`src/features/platform`,
`app/plataforma`, `scripts/create-superadmin.ts` y su entrada de npm
`create:superadmin`— se retiró por decisión del dueño («del 1 si no hace nada
eliminarlo») porque su ÚNICA escritura era la fecha de arranque de la nómina, y
esa configuración ya no existe. `tests/platform-retirement.test.ts` fija el
retiro: que nada bajo `src/` ni bajo `app/` la nombre, la importe o la enlace.

La instalación es de **una sola sede** (decisión del dueño) y **no tiene ninguna
propiedad que alguien pueda configurar desde la app**. Un operador nuevo no
configura nada: crea el proyecto de Supabase, aplica el esquema y los seeds (ver
**Inicio rápido**) y entra.

### El piso de la nómina lo da la evidencia

La fecha desde la que la nómina OPERA ya no se configura: se **deriva** de la
EVIDENCIA —el día más ANTIGUO entre el inicio más antiguo de los períodos
(`payrollHistoryFloor`) y el día Bogotá de la primera factura no anulada—, por
`payrollEvidenceFloor` (`src/features/payroll/schemas.ts`). El resultado lo
expone `getPayrollStartDate` (`src/features/payroll/service.ts`) como
`getPayrollStartDateAction` (`src/features/payroll/actions.ts`). Sin evidencia
NINGUNA, el piso lo **declara** la PRIMERA liquidación: su primer ciclo se
recorta al día declarado (`resolveOpenPayrollRange`), y es la única vez que se
pregunta. Mientras tanto el valor es `null`, y eso significa exactamente «la
nómina todavía no tiene primer período», no «falta configurarla».

La escritura que quedaba —la que fijaba ese día— estaba en la capa de plataforma
y se retiró con ella. El día se declara UNA vez y después es **solo lectura**:
moverlo implicaría reescribir períodos ya liquidados, así que no hay superficie
que lo mueva, y no hace falta que la haya.

### El rol `superadmin`: deuda declarada, no superficie

El rol **sigue en el catálogo** de la base
(`supabase/migrations/001_orabella_schema.sql`) y en el tipo `RoleCode`
(`src/features/auth/schemas.ts`), y sigue **sin ser asignable** desde la
administración de una sede: lo asignable es `sedeAssignableRoleSchema` =
`["admin","empleado","caja"]`. `setUserRoles` lo rechaza en las **dos
direcciones** —otorgarlo, y quitárselo a quien ya lo tenga— antes de llamar al
`rpc`, así que la base no escribe nada.

Es deuda declarada a propósito: retirar el código no borra la fila del catálogo
ni regenera el archivo único de esquema, porque eso obligaría a resetear las dos
bases. Quitarla es otra unidad, con su migración. El guard que la mantiene
escrita está en `tests/platform-retirement.test.ts` («la base NO se toca»). La
misma deuda incluye `sedes.payroll_start_date`, la columna que ya no tiene
quien la escriba ni la lea.

### Lo que sigue autorizando es el ROL, no la sede

`requireSedeRole()` (`src/shared/lib/sede.ts`) es la frontera real (ver
**Seguridad**): autoriza por rol. La comparación por sede (`resolveSede`) **ya no
es frontera de nada** —se retiró con la columna `sede_id`, porque con una sola
sede comparar la sede solicitada con la de la sesión no acotaba nada—. La 077
borró `sede_id` de las veinte tablas de negocio y dejó **una sola columna viva,
`users.sede_id`** (hoy nullable), como anclaje de la cuenta a la instalación. De
esa fila la sesión deriva `sedeId`, pero es un campo **devuelto**, no un criterio
con el que el negocio acote sus lecturas.

### Efecto en las variables de entorno

No queda ninguna variable «de la plataforma». `SUPERADMIN_PASSWORD` —la única
que vivía fuera de `.env.local`, en el entorno de la corrida— desapareció con el
script. La tabla de **Env** de arriba es la lista completa de lo que hay que
definir.

---

## Convenciones

- **Modo oscuro sin flash (NFR-06):** `ThemeProvider` (`attribute="class"`) +
  cookie `orabella-theme` leída en SSR (clase inicial en `<html>`) + script
  inline bloqueante (`beforeInteractive`, en `app/layout.tsx`) +
  `suppressHydrationWarning` + variables CSS (`@custom-variant dark` en Tailwind 4).
- **Zona horaria de presentación (D5, decisión: dejarlo como está):** el cálculo
  de negocio usa `America/Bogota` (`src/shared/lib/dates.ts`), pero lo que se
  **muestra** en pantalla sale del reloj del navegador: `formatDateTime`
  (`src/shared/lib/format.ts`) llama a `toLocaleString` sin `timeZone`. Un
  usuario con la máquina en otro huso ve las horas corridas, sin error ni aviso.
  Se revisó y se dejó así a propósito (una sola sede, personal en Colombia, y
  fijarlo cambiaría la fecha y hora de todas las pantallas ya aceptadas); el
  punto único si algún día se fija es esa función. No es un olvido.
- **API-first (§10):** lógica en servicios del servidor; web vía Server Actions,
  futura app vía REST `/api/v1` (hoy todas las rutas autentican con la cookie de
  sesión `orabella_session`, no con JWT de Supabase; errores
  `{success:false, code, message}`).
- **Seguridad:** `service_role` solo en servidor (jamás con prefijo
  `NEXT_PUBLIC_`); validación Zod server-side en toda escritura; RLS está **fuera
  del modelo de amenaza** (ver **Seguridad**).
- **Migraciones y seeds:** `supabase/migrations/001_orabella_schema.sql` es el
  esquema completo en **un solo archivo** (36 tablas, 28 funciones, 10 políticas,
  65 índices, 21 disparadores): un volcado de la serie histórica 001–078. Se
  aplica **una vez** sobre un proyecto Supabase nuevo, dentro de una transacción
  (`psql -v ON_ERROR_STOP=1 --single-transaction`). El arranque es esquema →
  `supabase/seeds/catalog.sql` → `supabase/seeds/acceptance.sql`. La serie
  original queda en `supabase/schema-history/` como explicación y respaldo; el
  procedimiento que regenera el archivo único está en `supabase/squash/README.md`.

---

## Seguridad (T8 — endurecimiento)

### Postura real (D8): RLS está FUERA del modelo de amenaza

Escrito para que nadie cuente con una segunda línea de defensa que no existe.

- **La app nunca ejecuta una consulta bajo RLS.** El único cliente que importa
  una feature es `createAdminClient()` (`src/shared/lib/supabase/server.ts`), que
  se construye con `SUPABASE_SERVICE_ROLE_KEY` — la clave `service_role`, que
  **bypasea RLS por diseño**. Lo usan los ocho servicios de feature
  (`src/features/admin/service.ts`, `alerts/service.ts`, `auth/service.ts`,
  `billing/service.ts`, `cash/service.ts`, `commissions/service.ts`,
  `inventory/service.ts`, `payroll/service.ts`) y `src/shared/lib/audit.ts`.
- **Los dos clientes con RLS son código muerto.** `createClient()` de
  `src/shared/lib/supabase/server.ts` (anon key + cookies de la request) y
  `createClient()` de `src/shared/lib/supabase/client.ts` (navegador, anon key)
  están exportados y **no los importa nadie: 0 importadores**. No se borran
  —siguen siendo el camino correcto si algún día se migra la app a RLS— pero hoy
  no protegen nada. **No los cuentes como barrera.**
- **La única barrera real es el código de aplicación:** `requireSedeRole()`
  (`src/shared/lib/sede.ts`) y los filtros que cada servicio aplica a mano antes
  de consultar. Un guard olvidado es una brecha total, no un agujero parcial: no
  hay nada detrás. **La frontera es de ROL, no de sede**: con la base bypaseando
  RLS, lo que rechaza una operación es el rol del actor (`admin`/`caja`/
  `empleado`/…; el `superadmin` del catálogo ya no autoriza nada), y ya no una
  comparación de `sede_id` —esa se retiró con la columna.

### El esquema sí trae RLS (dato, no protección)

- RLS está **habilitado en las 36 tablas** y hay **10 políticas** en
  `supabase/migrations/001_orabella_schema.sql`:
  - **4 aíslan por `users.sede_id`** mediante `public.current_sede_id()`
    (`users`, `user_roles`, `sessions`, `password_resets`);
  - **6 usan `USING (true)`**: `pol_roles_readonly` (catálogo global, solo
    `SELECT`) y cinco de nómina / ajustes que se quedaron sin `sede_id` cuando la
    077 lo borró de las veinte tablas de negocio.
- `public.current_sede_id()` lee `auth.jwt() -> 'app_metadata' ->> 'sede_id'`.
  La inyección de ese claim depende del Auth Hook del proyecto Supabase, que no
  se declara en el repo.
- Aun así **no es una defensa activa**: como el tráfico de la app va con
  `service_role`, RLS no se evalúa nunca.

### Lo que NO se puede verificar desde el repo

- Qué migraciones y qué políticas están aplicadas en el proyecto Supabase
  desplegado. El esquema se aplica a mano
  (`supabase/migrations/001_orabella_schema.sql`) y no hay
  `supabase/config.toml`, así que el estado real se comprueba en la base, no acá.

### Auditoría

- `audit_logs` (TRA-01) + `src/shared/lib/audit.ts` (`writeAudit()` con
  service_role, nunca en cliente). `writeAudit()` **nunca lanza**: ante cualquier
  fallo registra en consola y devuelve `{ written: false }` para no romper el
  flujo de negocio.
- Acciones del vocabulario cerrado `AUDIT_ACTIONS`: login fallido / bloqueo,
  cambio de clave y rollback fallido de alta de usuario; factura creada /
  editada / anulada; turnos de caja (cierre, desajuste de apertura y de cierre,
  edición, reconteo, base de caja); nómina (calculada, cerrada, eliminada, pago
  extraordinario, corrección de período, pago de comisión, anclaje por
  cadencia); topes de vales y vales solicitados / aprobados / rechazados.

### Rate-limit

- `src/shared/lib/rate-limit.ts` — Upstash Redis REST cuando existen
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (5 intentos / 15 min por
  documento en login y password-reset); sin ellas, fallback a memoria del proceso
  con advertencia en el log (no válido en multi-instancia).

---

## Orden de construcción (T1 → T8)

1. **T1** scaffold + fundación (layout, health, vitest).
2. **T2** auth (AUTH-01…07) → 3. **T3** admin (ADM-01…08) → 4. **T4** inventario
   (INV-01…05) → 5. **T5** factura interna (FAC-01…07) → 6. **T6** caja
   multi-turno (CAJ-01…06) → 7. **T7** nómina/vales (PAY-01…07 + TRA-01…03) →
   8. **T8** endurecimiento (RLS + auditoría + rate-limit + aceptación §11).
