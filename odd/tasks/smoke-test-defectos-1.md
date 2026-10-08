# Smoke test contra las bases reseteadas — los tres primeros defectos

## Objective

Pagar los tres defectos que aparecieron en la **primera entrada real** a la aplicación
contra las bases reseteadas con el archivo único de esquema (`001_orabella_schema.sql`).
El smoke test funcional era el pendiente declarado en
`esquema-mono-sede-y-archivo-unico.md` («Next step»): la base estaba verificada a nivel de
esquema, permisos y firmas de RPC, pero nadie había operado la aplicación.

Los tres son defectos de **código**: una puerta que intercepta activos estáticos, un
código interno que se filtra al usuario, y un vacío que miente sobre la causa.

## Problem

### D1 — El logo sale roto en el login: el middleware intercepta los activos estáticos

`app/middleware.ts` es la puerta gruesa de autenticación. Su matcher excluye
`_next/static`, `_next/image` y `favicon.ico`, pero **no** el resto de `public/`. Con la
cookie ausente —o sea, en `/login`, que es exactamente donde se muestra el logo— la
petición del activo cae en la puerta y se responde con una redirección.

Medido contra el servidor de desarrollo:

```
$ curl -s -o /dev/null -w "status=%{http_code} redirect=%{redirect_url}" \
    http://localhost:3000/orabella-logo.png
status=307 redirect=http://localhost:3000/login?next=%2Forabella-logo.png
```

El `<img src="/orabella-logo.png">` de `app/app/login/page.tsx:41` recibe el HTML del
login en lugar del PNG: por eso «sale roto». El mismo destino tiene el `app/icon.png`
(la ruta `/icon.png`) y cualquier otro activo de `public/`.

Afecta a las dos superficies que muestran la marca sin sesión: el encabezado del login y
el paso de cambio forzado de clave, que viven en la misma página.

### D2 — El código interno `AUTH-01` se filtra al usuario

`app/app/login/login-form.tsx:162`, en el paso de cambio obligatorio de clave:

> Su clave inicial es su número de documento. Debe cambiarla antes de continuar **(AUTH-01)**.

`AUTH-01` es el identificador interno del requisito (aparece como tal en
`src/features/auth/service.ts:313,673` y en los comentarios de `schemas.ts:46` y
`constants.ts:22`). No es información del usuario: es vocabulario de implementación.

### D3 — La primera liquidación no se puede generar y el vacío no dice por qué

Al abrir el diálogo «Abrir período» con `payroll_start_date` sin configurar y sin ningún
período, el diálogo responde (`app/app/payroll/payroll-client.tsx:2766`):

> No hay ciclos cerrados sin liquidar **en esta sede**: no hay período que abrir. Cuando un
> ciclo cierre sin su liquidación aparecerá en el aviso de la pantalla, y desde ahí se abre.

Las dos afirmaciones son falsas en ese estado:

1. **La causa no es «no hay ciclos».** `pendingPayrollSettlements` devuelve `[]` por la
   regla 4 de F10 (`src/features/payroll/schemas.ts`): *sin períodos y sin fecha de
   arranque no hay historia*, así que no hay piso desde dónde recorrer los ciclos. La causa
   real es que **la fecha de inicio de la nómina no está configurada**, y esa fecha se
   escribe en `/plataforma` (`platform.payroll_start_date_set`), no en nómina. El vacío que
   existe para el caso «ya liquidé todo» se está usando para un caso que no es ese.
2. **«En esta sede» no acota nada.** La instalación es de una sola sede por decisión del
   dueño (M1–M3c): el texto sigue nombrando un alcance que ya no existe.

Medido en PRUEBAS, que es la base que el servidor de desarrollo usa:

```
sedes: 1 fila («Sede principal», activa) · payroll_start_date = NULL
employees: 10 (10 activos) · payroll_periods: 0
```

Con la fecha configurada el ciclo pendiente aparece y el período se abre: el defecto es de
**diagnóstico**, no de cálculo. Lo que bloquea de verdad es la configuración ausente.

### Fuera de alcance (declarado)

- **Configurar `payroll_start_date` y crear la cuenta `superadmin`**: son acciones del
  dueño, con la app abierta. Se documentan en «Acciones del dueño».
- **El barrido del resto de la copia que dice «sede»**: esta unidad arregla la copia del
  flujo de nómina. El inventario completo de textos de usuario que nombran la sede va en una
  exploración aparte, para que el dueño decida el reemplazo de vocabulario de una vez.

## Design

- **D1**: la exclusión vive en el **matcher**, que es la única superficie donde Next evalúa
  antes de ejecutar la función. Se agrega la exclusión de los activos estáticos —la ruta con
  extensión de archivo— sin tocar `PUBLIC_PATHS`, que es la lista de rutas *de aplicación*
  públicas (`/login`, `/api/v1/health`, `/api/v1/auth/*`). El campo de juego no se mueve: la
  extensión no puede excluir una ruta de aplicación porque ninguna ruta de este proyecto
  lleva punto.
- **D2**: se borra el identificador del texto. El identificador sigue siendo el nombre con
  el que el requisito se cita en el código y en los tests; lo que se retira es su presencia
  en la cadena que lee una persona.
- **D3**: el vacío se parte en dos estados, con la MISMA fuente de verdad que el servicio.
  El cliente ya recibe `payrollStartDate` y ya tiene las funciones puras
  (`isRangeBeforePayrollStart`, `isPayrollCycleSettled`, `pendingPayrollSettlements`):
  - *sin fecha configurada y sin períodos* → dice que falta configurar la fecha de inicio de
    la nómina y dónde se configura (`/plataforma`);
  - *con fecha configurada* → el vacío de verdad («no hay ciclos cerrados sin liquidar»),
    sin la afirmación de alcance por sede.
  No se inventa ninguna regla de negocio: la condición es la misma que ya decide el servicio
  (`periods.length === 0 && payrollStartDate === null`, `service.ts:1366`).

## Scope

Código: la puerta del middleware, la copia del login y el vacío del diálogo de nómina, con
sus tests. Nada de cálculo de nómina, nada de esquema, nada de datos.

## Tasks

- [ ] **U1** — D1: que el logo vuelva a verse en el login.
      Excluir los activos estáticos en `app/middleware.ts` sin abrir ninguna ruta de
      aplicación, y fijarlo con un test que falle si un activo vuelve a caer en la puerta
      **y** que exija que las rutas reales sigan protegidas.
- [ ] **U2** — D2: sacar `AUTH-01` del texto que lee el usuario
      (`login-form.tsx`), con el test que hoy lo afirma repuntado a la cadena nueva.
- [ ] **U3** — D3: que el vacío del diálogo diga la causa verdadera.
      Los dos estados, sin «en esta sede», con el test de `payroll.test.ts` repuntado.
- [ ] **U4** — Gate completo (typecheck, suite, eslint), commits por unidad y push.

## Checks

- El logo responde 200 sin cookie y las rutas de aplicación siguen redirigiendo a `/login`.
- Ninguna cadena de usuario contiene códigos de requisito.
- El vacío del diálogo distingue «falta configurar la fecha» de «no hay ciclos pendientes».
- `npm run typecheck`, la suite completa y `npx eslint` en verde.

## Verification evidence

**Dos rondas de verificación independiente, y ninguna se apoyó en el autoinforme del writer.**

### Ronda 1 — los tres defectos

**Confirmado.** Números re-corridos por el verificador: 37 archivos / **1965 tests**, typecheck
(`tsc --noEmit`) y eslint sin diagnósticos. Empírico: logo y `/icon.png` 200 `image/png` sin
redirección; `/payroll`, `/invoices`, `/admin`, `/plataforma` 307 a `/login`;
`/api/v1/payroll-periods` 401; `/login` y `/api/v1/health` 200.

Hallazgos que trajo, y el destino de cada uno:

| Hallazgo | Destino |
| --- | --- |
| La exclusión del matcher era más estrecha de lo que decía: sólo miraba el primer segmento, así que `/images/logo.png` seguía cayendo en la puerta | Corregido en el follow-up (ronda 2) |
| La copia nueva manda al lector a `/plataforma`, que es solo-`superadmin`, mientras el diálogo lo ve el admin de la instalación: cierta pero **no accionable** por quien la lee | Se resuelve en `fecha-arranque-automatica.md`: esa pantalla se retira y el mensaje deja de mandar a otra pantalla |
| Dos mensajes con `la nómina de esta sede` sobrevivieron en el mismo handler que la guarda miraba (`payroll-client.tsx:1525`, `:2028`): la guarda buscaba la frase exacta `en esta sede` | Asignados explícitamente a U11 de `fecha-arranque-automatica.md`, que es la unidad que los reescribe |

### Ronda 2 — el matcher, ya en su forma final

**Confirmado.** El verificador **enumeró las rutas reales del filesystem** en vez de confiar en la
lista del test: **ningún segmento de ruta contiene un punto** (el único `\.` del árbol es el
catch-all `app/api/v1/auth/[...action]`, que es sintaxis de brackets, no un punto de URL), y
`next.config.ts` sólo declara `headers()` —sin `rewrites`, `redirects`, `basePath` ni
`assetPrefix`—, así que nada contradice el invariante.

Compiló el matcher por su cuenta y probó activos a uno, dos y tres niveles, con y sin query,
todas las rutas de aplicación, directorios punteados, trailing slash y formas de evasión (punto
percent-encoded, extensión en mayúsculas, `//` de prefijo, `..`). Todas las filas dieron lo
esperado. **Los tests no son tautológicos**: compilando los matchers revertidos, 7 aserciones
fallan contra la forma original y 6 contra la anterior.

Números: 1 archivo / 9 tests; **37 / 1969**; typecheck y eslint limpios.

**El primer intento estaba mal en las dos direcciones**: además de no excluir los activos
anidados, **abría** `/v1.2/payroll`. No llegó a commitearse — lo cazó la verificación, no el
razonamiento.

### Límite declarado — verificado y NO arreglado

La exclusión es **de forma, no una lista de rutas conocidas**: cualquier camino que *parezca* un
archivo queda fuera de la puerta gruesa. El caso observado por el verificador es un **parámetro
dinámico con punto**: `/api/v1/payroll-periods/12.3` esquiva la puerta y responde con el 401 del
propio handler (medido, 401). Las formas `/payroll.` y `/.env` también quedan fuera del matcher y
hoy dan 404 porque no existe tal ruta ni tal archivo.

No se arregla, y las dos razones son de criterio, no de pereza:

1. **La puerta es gruesa por diseño.** Su propio contrato declara que la validación real de sesión
   vive en cada pantalla y cada handler, y la verificación comprobó que **todos** los handlers
   salvo el `health` público referencian una guarda de sesión.
2. **Cerrarlo por forma pide una lista de extensiones de activo** (o una anidación de lookaheads)
   para un agujero **sin alcanzabilidad observada**: la lista es más trampa de mantenimiento que
   el riesgo que cierra, y el proyecto ya sostiene la autorización con guardas por test.

Si algún día molesta, el camino correcto está anotado: la lista de extensiones.

## Progress

| Unidad | Commit |
| --- | --- |
| U1 — el logo en el login | `d0e9015` |
| U2 — `AUTH-01` fuera de la copia | `0c8c975` |
| U3 — el vacío del diálogo | `95f9a87` |
| U4 — documentación | — |

## Acciones del dueño (no son código)

1. **Crear la cuenta de plataforma** en PRUEBAS — el reset la borró, y sin ella no hay
   quién configure la instalación:
   `export SUPERADMIN_PASSWORD='...' && npm run create:superadmin` (el documento de entrada
   es `superadmin`, y la clave sale SÓLO de esa variable: no tiene valor por defecto).
2. **Configurar la fecha de inicio de la nómina** en `/plataforma` — es lo que desbloquea
   la primera liquidación. No depende de esta unidad: se puede hacer ya.
3. **Rotar las dos claves de Supabase** expuestas durante la sesión del reset, y actualizar
   las variables de entorno (al rotar la clave cambia también la contraseña del pooler).

## Route declaration

Defectos de código con base en ejecución real (una entrada a la aplicación y tres lecturas
de sólo lectura contra PRUEBAS). La escritura sobre PRUEBAS no se toca en esta unidad.
