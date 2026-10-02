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

## Cuenta de plataforma (`superadmin`)

La capa de plataforma (ver `odd/tasks/plataforma-super-admin.md`) se administra
con UNA sola cuenta: documento `superadmin` con el rol `superadmin`, anclada a la
**sede de plataforma**. Esa cuenta **no** se crea desde la administración de una
sede —`adminCreateUser` no admite
ese rol, que solo otorga la plataforma— así que se aprovisiona con un script del
repositorio:

```bash
npm run create:superadmin
```

### Variables: el script carga los archivos de entorno del proyecto

El script arranca cargando los archivos de entorno del proyecto con
`loadEnvConfig` de `@next/env` —el mecanismo canónico de Next, que ya viene con
`next`—, así que lee los MISMOS archivos que la app (`.env.local` entre ellos)
**antes** de mirar las variables. Con `.env.local` presente, lo único que hay que
definir a mano es `SUPERADMIN_PASSWORD`:

| Variable | Qué es |
|---|---|
| `SUPERADMIN_PASSWORD` | La clave de la cuenta. **Obligatoria y sin valor por defecto**: si falta o viene vacía, el script no escribe nada y falla. Es la ÚNICA variable propia del script y la única que NO va en `.env.local`. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Las mismas de la app: salen de `.env.local` y el script usa `createAdminClient()` (service_role). El host de la URL es lo que imprime antes de escribir. |

**Precedencia:** lo que YA está en el entorno del proceso **gana** sobre el
archivo (es la precedencia normal de Next, y el script la impone de forma
explícita para que no dependa de un detalle interno). Así el dueño puede apuntar
a otra base a propósito, sin editar ningún archivo.

El script dice de dónde salieron las credenciales —solo nombres de archivo, nunca
valores—:

```text
[superadmin] entorno: archivos cargados: .env.local, .env — el entorno del proceso tiene prioridad sobre ellos
[superadmin] entorno: no se encontraron archivos de entorno; se usa sólo el entorno del proceso
```

**No hay variable de destino ni de sede.** El destino no se declara: cada entorno
tiene su propio `.env` y el script imprime el HOST de Supabase al que le escribe
justo antes de tocar nada —ese es el chequeo humano—. Y la sede ya no se elige:
la asegura el script (ver abajo).

**La clave no está en el repositorio** —no está en `.env.example`, ni en un seed,
ni en este README, ni en una prueba— y **no hay clave por defecto**, porque el
respaldo silencioso termina siendo la clave de producción. Vive solo en el
entorno con el que se corre el script; a la base baja únicamente su hash scrypt
(`hashPassword` de la app). El cargador leería la clave si estuviera en
`.env.local`, y por eso la decisión es **no ponerla ahí**: la credencial se define
en el entorno de la corrida, no en un archivo.

El documento es el MISMO en los dos entornos; lo único que cambia es el valor de
las variables (y el `.env.local` de cada máquina):

```bash
# PRUEBAS y producción se distinguen por el VALOR y por el host que el script imprime.
export SUPERADMIN_PASSWORD='...'   # la ÚNICA a mano; sale del shell, nunca de un archivo
npm run create:superadmin
```

Si la máquina NO tiene `.env.local` (o se corre desde otro directorio), hay que
definir también las tres de Supabase en el entorno, porque no hay archivo del que
salgan.

### Definir la clave en el shell (la trampa que ya nos costó una corrida)

La clave es la única variable que se define a mano, y **cómo se define depende del
shell**:

```powershell
# PowerShell: `set VAR=valor` NO define una variable de entorno (es un alias de
# Set-Variable: la variable existe en la sesión, pero los procesos hijos NO la
# heredan, así que npm/node no la ven). Se usa $env:, y vale sólo para esa ventana.
$env:SUPERADMIN_PASSWORD = '...'
npm run create:superadmin
```

```cmd
:: cmd.exe: `set VAR=valor` SÍ define una variable de entorno (sólo para esa ventana).
set SUPERADMIN_PASSWORD=...
npm run create:superadmin
```

```bash
# sh/bash: `export` para que el proceso hijo la herede (sólo esa ventana).
export SUPERADMIN_PASSWORD='...'
npm run create:superadmin
```

### La sede de plataforma

`users.sede_id` es NOT NULL (003_admin.sql), así que la cuenta tiene que
pertenecer a alguna sede. Pedirla por variable obligaba a elegir una sede de
CLIENTE para una cuenta que está para ajustar el SISTEMA. En su lugar, el script
**asegura** una fila de `sedes` llamada `Plataforma (sistema)`:

- **Idempotente por NOMBRE**: si la fila ya existe la usa, y no crea otra.
  `sedes` no tiene `code` ni unicidad por nombre, así que el nombre es la única
  clave estable; si aparecen dos filas con ese nombre, el script falla en vez de
  elegir una al azar (y relee después de crear, para que dos corridas
  simultáneas tampoco dejen dos).
- Se crea con **`is_active = false`**: no es una sede operativa. Si la fila ya
  existía **ACTIVA**, el script la usa igual y lo dice con un AVISO: no cambia el
  estado de una sede que no creó.
- Si la sede no se puede asegurar, **falla antes de tocar la cuenta**.
- **No se relaja `users.sede_id` ni se toca `resolveSede`/`requireSedeRole`**
  (`src/shared/lib/sede.ts`): esa frontera sostiene el aislamiento por sede de
  todas las rutas del negocio, y aflojarla para una cuenta lo propagaría a cada
  guarda. La sede de plataforma es la representación honesta de "no es una sede
  de cliente". Las guardas son puras sobre `sede_id` y no miran
  `sedes.is_active`, así que una sede inactiva no deja a la cuenta afuera de
  nada.
- Si la cuenta estaba anclada a otra sede, la corrida **la re-ancla a la sede de
  plataforma y lo dice** (cambiar de sede cambia lo que esa cuenta ve del
  negocio: no puede ser mudo).

**Nota (pendiente para G4):** el script crea la sede inactiva para que no se
ofrezca en los flujos del negocio, pero **hoy nada la excluye por `is_active`**:
`fetchSedes` (`src/features/admin/service.ts:123`) selecciona TODAS las sedes y
solo está expuesta por `listSedesAction` (`src/features/admin/actions.ts:167`),
que no tiene ningún consumidor en la interfaz. Cerrarlo es de G4.

### La cuenta ajusta el sistema, no opera el negocio

El conjunto de roles se fija **exactamente en `["superadmin"]`** en cada corrida
(`replace_user_roles` reemplaza el conjunto, no agrega). Esa es la DEFINICIÓN de
la cuenta, no una limitación pendiente: la cuenta existe para ajustar el sistema
y **no** para operar el negocio. Caja, facturas y nómina le quedan **sin
permisos**, y eso es deliberado.

### Qué hace (y qué no)

- **Idempotente**: la primera corrida crea la cuenta; las siguientes **actualizan**
  la clave y limpian el bloqueo por intentos. Nunca crea una segunda cuenta, ni
  una segunda sede de plataforma, ni duplica el rol: `replace_user_roles` deja
  exactamente `superadmin`.
- **Verifica de punta a punta**: al final vuelve a leer el hash guardado y
  comprueba que verifica con `verifyPassword()` —la misma función del login— con
  la clave del entorno. Si no verifica, falla en vez de dejar una cuenta que no
  puede entrar.
- Deja `must_change_password = false`: AUTH-01 fuerza el cambio cuando la clave
  inicial es el documento, pero acá la clave la eligió el despliegue y tiene que
  servir para entrar.
- **No habilita una cuenta deshabilitada**: si `users.is_active = false`, falla en
  vez de deshacer en silencio una decisión del dueño.
- No escribe auditoría: el vocabulario de `audit_logs` no tiene una acción de
  aprovisionamiento y esto no es una operación de la aplicación.

### El runner (por qué el script de `package.json` se ve así)

El proyecto no tiene `tsx` ni `ts-node`, y el script tiene que importar el
`hashPassword` de la app (con el alias `@/`) para que el hash no pueda divergir
del que verifica el login. El runner disponible es `jiti`: **no está declarado en
`devDependencies`**, pero queda instalado y fijado en `package-lock.json` como
dependencia de desarrollo porque `@tailwindcss/node` (y `vite`, como peer) lo
exigen; por eso **el script se corre en una copia del repo con las dependencias
de desarrollo instaladas** (con `--omit=dev` no hay runner). El CLI de `jiti` no
resuelve el alias `@/` sin la variable `JITI_TSCONFIG_PATHS` —que no se puede
fijar de forma portable en `cmd.exe` y en `sh`—, así que la entrada del
`package.json` levanta `jiti` con `{ tsconfigPaths: true }` y llama a `main()`.
Si algún día se agrega un runner propio (`tsx`), la entrada se cambia por
`tsx scripts/create-superadmin.ts` y el script no se toca.

**El script se corre DESDE la máquina del dueño**, contra la base remota, con las
credenciales que salen de su `.env.local` (o del entorno del proceso, que tiene
prioridad): no hace parte del despliegue de la app y no se ejecuta desde el
servidor de producción. Necesita, por lo tanto, un checkout del repositorio con
las dependencias de desarrollo instaladas (`npm ci`). Si algún día tiene que
correrse en un entorno que no las tenga, hay que **declarar el runner** en el
proyecto —`tsx`, por ejemplo—: eso sería su propia unidad, con su propio cambio
de `package.json` y de `package-lock.json` y su propio gate.

Si el runner no está instalado, el arranque lo dice en vez de morir con el error
de Node sobre un módulo que no encuentra:

```text
[superadmin] Falta el runner TypeScript: este comando necesita las dependencias de desarrollo instaladas en el checkout, con npm ci y sin --omit=dev. jiti no es una dependencia declarada del proyecto: llega con @tailwindcss/node y vite. Ver el README: Cuenta de plataforma.
```

## Estructura

```text
app/                      # App Router (layout, page, globals.css, api/v1/*)
src/features/{admin,alerts,auth,billing,cash,commissions,inventory,payroll}/  # un módulo por feature, con README propio
src/shared/{components,lib,config}/  # theme, api-response, supabase client/server, audit, rate-limit, env
supabase/migrations/      # SQL versionado (001 fundación; dominio en T2→T7; endurecimiento en T8; 009→031 ampliaciones)
supabase/seeds/           # seeds de aceptación §11 (T8, idempotentes)
tests/                    # suites vitest + e2e Playwright (tests/e2e/)
scripts/                  # operaciones de despliegue fuera de la app (alta de la cuenta de plataforma, G2)
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
