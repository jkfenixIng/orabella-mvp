# Plataforma: super admin, sedes y módulos por sede

> **Corrección de rumbo (decisión del dueño 2026-10-01, registrada 2026-10-02).**
> La premisa de este documento cambió: la instalación es de **una sola sede,
> físicamente**. El texto de abajo se conserva como historia de lo que se decidió,
> pero lo que ya no manda está marcado **`SUPERADO`** y lo que sigue en pie
> **`VIGENTE`**. El detalle de la corrección y el plan de migración a sede única
> están en «Corrección de rumbo y plan de sede única», más abajo en este documento.

## Objective
Una capa por encima del negocio donde **solo el dueño** administra la instalación:
la fecha de activación de nómina, la creación de sedes y quién es admin de cada
una, y el encendido/apagado de módulos **por sede**. Fuera del alcance de
cualquier administrador de sede.
— **SUPERADO en sus dos últimas cláusulas** (2026-10-01): no se crean sedes ni se
reparten admins por sede, y el interruptor de módulos no es por sede. Lo que
queda en pie es la primera: la fecha de activación de nómina la configura la
plataforma.

## Problem
Hoy el techo de privilegios es "admin de sede". Y "plataforma" es
**irrepresentable**: el catálogo de roles está fijado por un `CHECK` en la base a
tres códigos (`002_auth.sql:51`), y todo usuario pertenece a una sede
(`users.sede_id NOT NULL`, `003_admin.sql:48`). No existe **ningún** ajuste de
instalación: todo es por sede.

Dos agujeros que ya existen y que esta capa cierra:
- `listSedesAction` (`src/features/admin/actions.ts:167`) está guardada solo por
  `requireSession`: **cualquier rol logueado lista todas las sedes**.
- `upsertSedeAction` (`:177`) está guardada por `requireAdminSession`: **el admin
  de cualquier sede crea y edita sedes**.

## Decisiones del dueño (2026-10-01)
> Se conservan tal como se tomaron. Dos quedan superadas por la corrección de
> rumbo posterior: el alcance en su parte de sedes, y el interruptor por sede.

- **Alcance**: configuración de plataforma + gestión de sedes y admins. No
  incluye (por ahora) ver la auditoría global ni métricas.
  — **PARCIALMENTE SUPERADO**: la configuración de plataforma sigue igual; la gestión
  de sedes y de admins desde la plataforma se retiró (M1). La gestión de usuarios
  quedó en el admin de sede.
- **Módulos: por sede.** Cada sede puede tener apagado lo que no usa.
  — **SUPERADO**: el interruptor es de la instalación, no de una sede. Nunca se
  construyó (no existe la tabla `sede_modules` ni `requireModule`), así que no hay
  nada que revertir: solo una decisión que no se debe volver a tomar.
- **Identidad: un rol en la base**, asignable solo desde la plataforma.
  — **VIGENTE**: el rol de plataforma no se otorga ni se quita desde la
  administración de una sede. Es autorización, no estructura de sedes.
- **Apagar un módulo apaga las tres puertas**: desaparece del menú, la ruta se
  bloquea y las acciones del servidor de ese módulo lo rechazan.
- **Credencial**: usuario **`superadmin` igual en PRUEBAS y producción**, con la
  contraseña **distinta por entorno y tomada de una variable** al desplegar.
  El script **falla si la variable no está**: no hay clave por defecto, que es el
  error clásico (el respaldo termina siendo la clave de producción).

## Corrección de rumbo y plan de sede única (dueño, 2026-10-01)

**Decisión.** El proyecto no es "una sede por ahora": es de **una sola sede,
físicamente**. Hay un salón y no hay plan de otro. La premisa que justificaba el
diseño multi sede desapareció, y con ella la columna `sede_id`, que se va a
eliminar. Esto no es un matiz: lo que este documento decidió *por sede* queda sin
objeto y no debe volver a decidirse así.

### Qué sobrevive y qué no
- **VIGENTE**: el rol `superadmin` como rol ADICIONAL (no es una sede), la guarda
  `requirePlatformAdmin`, `requireSedeRole`, y la regla de que el rol de plataforma
  no se otorga ni se quita desde la administración de una sede. Son autorización, no
  estructura de sedes.
- **VIGENTE**: la credencial por entorno, sin clave por defecto.
- **VIGENTE**: `resolveSede` SE QUEDA. Con `service_role` saltándose RLS es la
  frontera de tenant de las rutas del negocio, y está documentada como tal. Se
  retira junto con la migración que elimina la columna, no antes.
- **VIGENTE**: la gestión de usuarios **se queda en el admin de sede** (`/admin`).
- **SUPERADO**: la plataforma ya **no** crea sedes ni reparte admins por sede
  (retirado en M1). `/plataforma` configura **la instalación**: su fecha de
  activación de nómina, que sigue auditada y detrás de `requirePlatformAdmin`.
- **SUPERADO**: el interruptor de módulos **no es por sede, es global**.

### Plan de la migración a sede única
- **M1 — Hecha.** Retirar la estructura multi sede: superficie de sedes en la
  plataforma, `listSedes`/`upsertSede` y la distribución de admins. `resolveSede`
  se conserva como frontera de tenant y queda documentada como tal.
- **M2 — Hecha.** Re-emitir las 12 funciones atómicas sin `p_sede_id`
  (`071_rpc_single_sede.sql`).
- **M3a — En curso.** Quitar los 53 filtros de sede en lecturas y la plomería
  muerta que quedó.
- **M3b — Pendiente.** Reemplazar `invoice_sequences` (cuya PRIMARY KEY es la sede) y
  `voucher_settings` por una tabla `system_settings` de clave/valor: es lo que
  eligió el dueño.
- **M3c — Pendiente, IRREVERSIBLE.** La migración que elimina la columna: 33
  políticas, 2 claves primarias, el `EXCLUDE`, ~17 índices y la columna en 21 tablas.
- **M4 — Pendiente.** Aplastar las 70 migraciones en UN solo archivo aplicado,
  archivar la historia fuera de la carpeta, resetear las bases y diffear el esquema
  antes y después.

**Por qué este orden.** El borrado de la columna va **al final** porque es el único
paso que no se deshace volviendo el código de la aplicación a su estado anterior. Las
unidades que cambian mucho archivo (M3a) van primero, donde un error se ve en los
tests; la irreversible va sola.

### Pendientes abiertos
- La fila de sede inactiva retirada `Plataforma (sistema)` **todavía existe** en la base
  del dueño: es residuo de la estructura multi sede. Hay que borrarla **antes del
  aplastamiento (M4)**, porque ninguna migración la va a acarrear cuando se elimine la
  columna. El script de super admin exige exactamente **una** sede **activa**
  (`leerSedeDeLaInstalacion`) y **no cuenta las inactivas**, así que esa fila no lo
  bloquea hoy: es limpieza pendiente, no un bloqueo.
- ¿Se puede borrar también `users.sede_id`? Hoy ancla la cuenta de plataforma
  (`users.sede_id` es NOT NULL). Decisión abierta para M3c/M4.
- Consecuencia concreta de M3b: **quitar `invoice_sequences` reinicia el consecutivo de
  la facturación**. Hay que decidir si el contador arranca de cero o hereda el último
  número en su fila de `system_settings`.

## Design
### Rol
> **VIGENTE**, sin cambios de código: es rol y autorización, no sede.

- Cuarto código de rol `superadmin`, con migración que amplía el `CHECK` de
  `roles.code` y el `roleCodeSchema` (`auth/schemas.ts:8`) y el espejo `SedeRole`
  (`shared/lib/sede.ts:30`).
- **Es un rol ADICIONAL, no una sede nueva.** El usuario `superadmin` conserva su
  `sede_id` (la columna no admite nulos y relajarla tocaría todas las guardas).
  Para el negocio sigue siendo un usuario de su sede; para la plataforma, el
  privilegio viene del rol. Así **no se toca `resolveSede` ni ninguna de las 30
  rutas**: `resolveSede` es la frontera que no se relaja.
  - **Precisión de 2026-10-02**: `resolveSede` **se queda** y queda escrito que es la
    frontera de tenant de las rutas del negocio, porque la capa de datos usa
    `service_role` y salta RLS. No es plomería de sede: se retira junto con la
    migración que elimina la columna, no antes.
- Guarda nueva `requirePlatformAdmin` con `PLATFORM_ROLES: RoleCode[] = ["superadmin"]`
  (declarada así para que `action-guards` pueda leerla).

### Superficie
- Carpeta nueva `app/app/plataforma/`, hermana de los módulos de negocio: el
  middleware ya la protege por cookie y el shell ya la envuelve.
- Entrada de nav con `roles: ["superadmin"]`: el filtro fail-closed de
  `main-nav.tsx:137` la deja invisible para todos los demás **sin código nuevo**.
  Hay que tocar también la lista duplicada de `app/app/page.tsx:12-55`.
- Las lecturas cross-sede son **funciones nuevas y explícitas**
  (`service_role`, sin predicado de sede). Nunca se relaja `resolveSede`.
  — **SUPERADO en su forma**: no hay lecturas cross-sede que hacer. La superficie ya
  no lista sedes ni muestra directorio de usuarios de otra sede.

### Módulos por sede — SUPERADO
> Este bloque se conserva como historia de una decisión que ya no aplica. El
> interruptor, si algún día se construye, es **de la instalación**: un solo estado
> para toda la instalación, no una fila por sede. **No se construyó nada de esto**
> (no hay tabla `sede_modules`, ni lectura para el nav, ni `requireModule`), así que
> G6 y G7 no quedaron a medias: no había nada empezado. Cuando se pida, es una
> unidad nueva y con su propia decisión.

- Tabla `sede_modules (sede_id, module_code, enabled)` con `UNIQUE (sede_id,
  module_code)` y `CHECK` del código contra la lista de módulos; ausencia de fila
  = encendido (fail-open explícito para no apagar todo en una instalación nueva).
- Códigos: `caja`, `inventario`, `facturacion`, `vales`, `nomina`, `alertas`,
  `servicios`.
- Lectura barata para el nav (`layout.tsx`) y para la guarda: una sola consulta
  por request, con la misma historia de frescura que los catálogos cacheados
  (`revalidateTag`).
- Triple puerta: filtro del nav (las DOS listas), guarda de página, y
  `requireModule(sedeId, code)` como **primera** llamada de cada acción del módulo
  y de cada ruta de API.

## Scope
Dentro: rol `superadmin`, la superficie `/plataforma`, sedes y admins desde ahí,
la fecha de activación de nómina, y el apagado de módulos por sede con sus tres
puertas.
— **Actualizado 2026-10-02**: dentro queda el rol, la superficie `/plataforma`
(configuración de la instalación) y la fecha de activación de nómina. Las sedes y
admins desde la plataforma se retiraron; el apagado de módulos por sede no se
construyó y su forma, si se pide, es global.

Fuera:
- Relajar `resolveSede` o el aislamiento por sede del negocio. — **VIGENTE**: es la
  frontera de tenant mientras la columna exista.
- Cambiar el `users.sede_id` a nulo. — **SUPERADO como prohibición**: si la columna
  `sede_id` desaparece, `users.sede_id` es parte de lo que hay que decidir. Queda
  abierto si se borra también o si se queda solo para anclar la cuenta de
  plataforma (hoy `users.sede_id` es NOT NULL).
- Auditoría global y métricas (queda para otra decisión).
- Tocar la aritmética de nómina, comisiones o vales.

## Constraints
- Migraciones las aplica el dueño a mano en PRUEBAS.
- Cada acción nueva se declara en la tabla `SURFACES` de `tests/action-guards.test.ts`.
- Ningún conteo pinneado puede moverse sin decirlo y explicarlo.
- La credencial no vive en el repo; el script falla si falta la variable.

## Tasks
- [x] G1 rol `superadmin`: migración del `CHECK`, esquema, espejo y la guarda de plataforma
      (`069_superadmin_role.sql`, `requirePlatformAdmin`)
- [x] G2 alta del usuario `superadmin` desde variable de entorno, sin clave por defecto
      (`scripts/create-superadmin.ts`)
- [x] G3 superficie `/plataforma` — **resuelta sin la lista de sedes**: la pantalla
      configura la instalación y su fecha de activación de nómina
- [x] G4 cerrar los dos agujeros: `listSedes` y `upsertSede` — **resueltos retirando las
      dos acciones**: con una sola sede no hay lista ni alta de sede que proteger
- [x] G5 sedes y admins desde la plataforma — **SUPERADO**: la estructura de sedes se
      retiró (M1). La gestión de usuarios **queda en el admin de sede** (`/admin`), por
      decisión del dueño, y el rol `superadmin` sigue sin otorgarse ni quitarse desde ahí
- [ ] G6 módulos por sede: tabla, lectura y las tres puertas, sobre un módulo de
      referencia — **nunca se empezó y su forma está superada**: si se pide, el
      interruptor es de la instalación (global). Unidad nueva cuando corresponda
- [ ] G7 el resto de los módulos, uno por unidad — igual que G6
- [ ] G8 gate completo + commits por unidad + push — sin marcar: el cierre de unidad vive
      en el gate de la rama, que sigue en curso con M3a

## Authorized scope
Capa de plataforma, roles, sedes, módulos por sede. Rama `feat/orabella-mvp`.

## Acceptance
- Solo una cuenta con el rol `superadmin` ve y usa `/plataforma`.
- Ese rol **no se puede otorgar** desde la administración de una sede.
- La fecha de activación de nómina se configura desde la plataforma.
- `listSedes` y `upsertSede` dejan de estar al alcance de cualquier rol.
  — **Resuelto por eliminación**: las dos acciones y su etiqueta de catálogo se
  retiraron; no queda superficie desde la que alcanzarlas.
- Apagar un módulo en una sede: desaparece del menú, la ruta se bloquea y sus
  acciones del servidor fallan, **sin afectar a las demás sedes**.
  — **SUPERADO**: no hay módulos por sede. Con una sola sede no hay "las demás", y
  el interruptor, si se construye, no es por sede. Sin implementar.
- La clave del super admin se define por entorno y el script no crea nada sin ella.
- `npm run typecheck` 0 y suite completa sin regresiones.

## Checks
`npm run typecheck`, `npm test` (full).

## Progress
- 2026-10-01: mapa de roles/nav/módulos hecho. Doc creado con las cuatro
  decisiones del dueño, la decisión técnica del rol adicional (sin tocar
  `resolveSede`) y los dos agujeros a cerrar. Pendiente: derivar G1 en cuanto se
  libere `tests/action-guards.test.ts`, que está tomado por F10.
- 2026-10-02: dueño corrigió la premisa (una sola sede, ver el bloque de corrección).
  M1 cerrada (estructura de sedes retirada, `resolveSede` conservada y documentada como
  frontera de tenant) y M2 cerrada (12 funciones atómicas re-emitidas sin `p_sede_id`,
  `071_rpc_single_sede.sql`). M3a en curso.

## Next step
- Continuar M3a (filtros de sede en lecturas y plomería muerta); después M3b
  (`system_settings`) y solo al final M3c, que es irreversible. Detalle y orden en
  «Corrección de rumbo y plan de sede única».

## Route declaration
- Delegación a `gentle-ai-worker` por unidad, con superficies disjuntas.
- `tests/action-guards.test.ts` es punto de colisión entre G1 y F10: van EN SERIE.
