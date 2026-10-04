# Auditoría responsive: qué se rompe en mobile

## Objective

Saber, con causa y medida, **qué pantallas se rompen o dejan de ser operables en un teléfono**.
El dueño lo pidió así: *«hay cosas que al verlas en mobile se rompen o no se deja acceder o ver»*.

## Por qué ahora

El smoke test funcional se hizo **en escritorio**. Nunca se recorrió la aplicación en un ancho de
teléfono, y la instalación es de un solo local que se opera desde el mostrador: si una acción no se
alcanza en mobile, no es una degradación estética, es una tarea que no se puede hacer.

## Método

- **Dos pasadas estáticas** sobre `app/app/**` y `app/src/**`: leer el código y citar `path:line` con
  la clase o el estilo que causa cada defecto.
- **Una pasada de medición en vivo** con Playwright, manejando la aplicación en
  **390×844, 360×640 y 320×568** (el último es el caso de estrés). Mide: desborde horizontal y su
  elemento culpable, **controles tapados** (`document.elementFromPoint` sobre el centro de cada
  botón y campo), contenido recortado por `overflow: hidden`, diálogos que no entran, y blancos
  táctiles por debajo de 24 px.
- **Sesión autenticada de prueba**: dos filas efímeras en `sessions` (lo mismo que escribe un login,
  sin tocar ninguna clave ni rol), que expiran solas. Los agentes **no mutan datos**: abrir un
  diálogo sí, guardar no, para que la prueba de humo del dueño encuentre la base como el seed la dejó.
- **Regla de prioridad**: un defecto en una **primitiva compartida** (diálogo, tabla, combobox,
  caja de texto) vale más que el mismo defecto en una pantalla, porque se multiplica.

## Hallazgos estáticos

### Rompen la operación

| # | Pantalla | Síntoma | Causa |
| --- | --- | --- | --- |
| R1 | `/inventory` | **«Crear producto» y «Registrar movimiento» desaparecen bajo el encabezado** al desplazar: las dos barras se pegan a `top-0` y la de abajo (`z-10`) queda detrás del encabezado (`z-30`), que mide ~62 px contra los ~66 px de la barra. En **todos** los anchos por debajo de `lg` | `app/inventory/inventory-client.tsx:317` `sticky top-0 z-10` vs `src/shared/components/main-nav.tsx:285` `sticky top-0 z-30` |
| R2 | carcasa, **todas las rutas** | El menú mobile declara `aria-modal="true"` pero **no atrapa el foco, ignora Escape y deja la página desplazándose detrás**. La carcasa *miente* sobre ser modal, y el `Dialog` de Radix —que sí atrapa foco, cierra con Escape y bloquea el scroll— **ya existe en el árbol** | `src/shared/components/main-nav.tsx:308-317`; cierres sólo por overlay (`:308-312`) y por ✕ (`:327-333`) |
| R3 | `/cash` | Columnas de administración (Diferencia, Revisada, Justificación, **Recontar**) a 800-1100 px del borde derecho, en una tabla de `min-w-[1100px]` | `app/cash/cash-client.tsx:81` + `:52` `whitespace-nowrap` |
| R4 | `/vales` | **«Aprobar» y «Rechazar»** —la acción por la que existe la pantalla— en la última columna de una tabla de `min-w-[760px]` | `app/vales/vouchers-client.tsx:671`, acciones en `:708-728` |
| R5 | `/payroll` | La tabla del borrador (1040 px) vive **dentro de un diálogo** de 272 px útiles: los campos de bono, descuento y **motivo obligatorio** hay que *tipearlos* ~770 px fuera de la pantalla, con dos ejes de scroll anidados | `app/payroll/payroll-client.tsx:591` `minWidth="2xl"` dentro de `:2974` `overflow-y-auto` |
| R6 | `/payroll` | «Ver» y «Ver facturas y vales» —el único camino para pagarle a un empleado— al extremo derecho de la misma tabla dentro del mismo diálogo | `app/payroll/payroll-client.tsx:366`, acciones en `:730-747` |

### Recortan o tapan contenido

| # | Pantalla | Síntoma | Causa |
| --- | --- | --- | --- |
| R7 | **todos los diálogos** | El diálogo es **de borde a borde** y con `p-6`: a 320 px el contenido queda en 272 px y las esquinas redondeadas tocan los bordes. El defecto compartido más caro: **16 diálogos** | `src/components/ui/lib/dialog.tsx:235` `w-full max-w-lg … p-6` sin margen |
| R8 | **todos los diálogos** | `max-h-[calc(100vh-2rem)]` usa **`vh`**, que en un teléfono real incluye la barra del navegador: el pie con los botones puede quedar **debajo del chrome**. Invisible en headless. El propio repo ya prohíbe `100vh` y usa `dvh` en `page.tsx:56` | `src/components/ui/lib/dialog.tsx:235` |
| R9 | `/invoices`, `/vales`, `/payroll` | **El desplegable del combobox queda recortado por el `overflow-y-auto` del diálogo**: es `absolute`, sin portal y sin voltear hacia arriba, así que las opciones son **inalcanzables**. No es estilo: `select.tsx:81-89` hace el portal correctamente | `src/components/ui/lib/combobox.tsx:122` |
| R10 | `/invoices` | El selector de tipo de ítem se parte dentro de un botón de alto fijo y se sale de su caja | `app/invoices/invoices-client.tsx:2868` `grid-cols-3` + `:2898` `h-9` |

### Blanco táctil y desbordes menores

| # | Pantalla | Síntoma | Causa |
| --- | --- | --- | --- |
| R11 | `/admin` (4 secciones) | Acciones de fila de ~20 px de alto, bajo el piso de 24 px. ~15 enlaces | `src/shared/lib/ui-styles.ts:39` `linkButtonClass` — **una sola corrección paga en cuatro secciones** |
| R12 | `/cash` | `Recontar`/`Versiones`/`Ver` son `underline` sin padding, ~20 px | `app/cash/cash-client.tsx:168,185,192` |
| R13 | `/services`, `/inventory`, `/admin` | Casillas de 16×16 px (`h-4 w-4`), y en empleados/roles casillas nativas **sin estilo**, ~13 px | `src/components/ui/lib/checkbox.tsx:17`; `employees-section.tsx:487,499,509`; `users-section.tsx:165` |
| R14 | todos | Botones de 36 px y de icono de 32 px, contra la meta de 44 px que **el propio repo se puso** (`docs/ux-ui-standard.md:226-232`) | `src/shared/lib/ui-styles.ts:20,24` |
| R15 | todas | `min-h-screen` en la raíz de la carcasa: página corta con scroll fantasma. `page.tsx:21-25` documenta haber quitado exactamente esto de `PageContainer` | `src/shared/components/app-shell.tsx:24` |
| R16 | `/invoices` | Control con `text-[10px]`, bajo el piso de 12 px | `app/invoices/invoices-client.tsx:231` |
| R17 | todas | `px-6 py-12` sin escalón responsivo: 24 px por lado a 320 px | `app/page.tsx:52` |
| R18 | carcasa | `☰` y `✕` son caracteres de texto con métricas distintas por plataforma, habiendo `lucide-react` ya importado | `src/shared/components/main-nav.tsx:300,330` |
| R19 | `/services`, `/inventory`, `/admin` | Sin alternativa en tarjetas: toda lista exige scroll horizontal. Pisos `min-w-[640px]`, `min-w-[760px]` y el `880px` por defecto de `DataTable` | `services-client.tsx:141`, `inventory-client.tsx:339,713`, `data-table.tsx:72,44` |
| R20 | `/payroll`, `/cash` | Sin navegación por secciones: `/payroll` son ~12 secciones apiladas y a 320 px la de calcular/cerrar queda a varias pantallas de scroll | estructura de `payroll-client.tsx`, `cash-client.tsx`; `tabs.tsx` existe y es correcto pero sólo lo usa `/admin` |

### Tercera pasada (primitivas compartidas y login)

| # | Pantalla | Síntoma | Causa |
| --- | --- | --- | --- |
| R21 | **los 41 `<Select>` de la app** | El viewport de opciones se ata a la **altura del disparador** (`h-[var(--radix-select-trigger-height)]`), con `position = 'popper'` **por defecto** en el wrapper, mientras el contenedor declara `max-h-96`: el desplegable mostraría **una opción** y el resto habría que buscarlo dentro de una ventana de ~40 px. **A medir antes de afirmarlo** | `src/components/ui/lib/select.tsx:75` (default) y `:94` |
| R22 | **todas las pantallas** | `inputClass` es `text-sm` (14 px): al enfocar un campo, **iOS hace zoom solo y descoloca la pantalla** en medio de la escritura. Y los campos quedan en ~37 px, bajo el piso táctil | `src/shared/lib/ui-styles.ts:13` |
| R23 | **global** | `body` no tiene guarda de `overflow-x`: cualquier desborde no contenido arrastra **la página entera** de costado en vez de un carril local | `app/globals.css:224` |
| R24 | todas | `buttonClass` no fija altura pero la primitiva base `Button` sí (`h-10`/`h-9`) y **fuerza `whitespace-nowrap`**: una etiqueta larga no se envuelve, empuja la fila | `src/components/ui/lib/button.tsx:9,21-25` |
| R25 | `/invoices` (10 sitios), `/inventory` | **Las reglas que deciden plata viven en `title=`**: los tooltips nativos **nunca aparecen con el dedo**, así que en un teléfono son invisibles. Igual el ayudante del SKU autogenerado | `invoices-client.tsx:1511,1518,1528,1558,2122,2516,2555,2602,2627,2632`; `inventory-client.tsx:491` |
| R26 | `/invoices`, `/cash`, `/admin` | Nombres con `truncate` + `title=`: la identidad queda cortada y el tooltip es la única recuperación, que en touch no existe | `invoices-client.tsx:1961,1964,1973`; `cash-client.tsx:52,122,128`; `users-section.tsx:121`; `employees-section.tsx:280` |
| R27 | carcasa | El cajón mide **288 px fijos**: a 320 px deja 32 px de franja, así que el velo para cerrarlo es **casi inagarrable** | `src/shared/components/main-nav.tsx:319` |
| R28 | `/alerts`, `/inventory`, `/invoices`, `/admin` | Filas de acciones con `flex gap-2` **sin `flex-wrap`**: «Guardar revisión» + «Cancelar» dan ~228 px contra ~240 disponibles | `alerts-client.tsx:263`; `inventory-client.tsx:428`; `invoices-client.tsx:2808`; `cash-section.tsx:215` |
| R29 | `/invoices` | Diálogos `p-0 max-w-4xl` envolviendo tablas de `min-w-[820px]`: **dos ejes de scroll anidados**, y el arrastre horizontal se come el vertical | `invoices-client.tsx:1403,2025,2330,2847,3276` con `:1449,2380` |
| R30 | `/payroll` | Un **segundo** scroller vertical dentro del `DialogContent`, que ya scrollea: los gestos pelean entre los dos | `payroll-client.tsx:2968,2974,3197` |
| R31 | `/login` | 96 px de relleno vertical (`py-12`) queman el 17 % de un viewport de 568 | `src/components/ui/lib/page.tsx:56` |

**Y dos verificaciones de la tercera pasada que valen**: ninguna cadena de una persona lleva un código de
requisito (está comprobado en los tres estados del login: `payload.code` nunca se renderiza, sólo
`payload.message`), y **el layout no bloquea el zoom** (no hay `maximum-scale` en el viewport).

## Verificado y limpio (para no volver a auditarlo)

- **No hay desborde horizontal de página**: `app-shell.tsx:26` empareja `min-w-0 flex-1` con la barra
  lateral, y **toda tabla ancha vive en su propio carril con scroll** (13 sitios de `<table>` en las
  cuatro rutas del dinero, `data-table.tsx:72` y los carriles a mano). Los carriles a mano son
  **deuda registrada**, no desvío: `tests/ux-data-table.test.ts:148-154` los cuenta (16).
- La tira de pestañas **envuelve** (`tabs.tsx:84` `flex-wrap`) y sus disparadores son `min-h-11`
  (44 px): el único control que ya cumple el piso táctil.
- La grilla de la home es `grid gap-4 sm:grid-cols-2` y las filas de filtros usan `flex-wrap`.
- `/inventory` es la única pantalla con la colisión de barras pegadas.

## Medición en vivo

**En curso**: dos pasadas de medición sobre las rutas del dinero y la carcasa/admin, más una tercera
focalizada en **las primitivas** (R21–R24, R27–R30), que es la que decide el contenido de la primera
unidad de arreglo.

**Límite conocido y declarado**: PRUEBAS tiene **cero turnos, cero facturas, cero vales y cero
períodos**, porque eso es justamente lo que crea la prueba de humo del dueño. Con las tablas vacías,
el estado vacío **tapa** los defectos de tabla: R3, R4, R5, R6 y R19 no se pueden medir de verdad
hasta que existan datos. **Segunda pasada de medición después de la prueba de humo** — que es la que
va a medir las tablas con filas reales.

**Además, lo que ninguna medición puede hacer**: R25 y R26 son tooltips. Tienen `path:line` y son
ciertos por lectura, pero no hay número que los mida: el tooltip nativo simplemente **no aparece con
el dedo**.

## Medición en vivo (resultados: carcasa, admin, inventario, servicios)

96 capturas y tres corridas de medición en navegador real, 3 anchos × 5 rutas + 6 secciones de
`/admin` + 7 diálogos. **Sin mutar un solo dato.**

### Confirmado con número

| Predicción | Veredicto y número |
| --- | --- |
| R2 — el cajón móvil no es modal | **Confirmado, por tres vías independientes**: con el menú abierto el fondo **sigue scrolleando** (`scrollTo(0,400)` → `scrollY=400` desde 0); **Escape no lo cierra** (`escapeClosed=false` en los tres anchos); y el foco **nunca entra** al abrir y al cerrar queda en `BODY`. En los tres anchos |
| R7 — diálogos de borde a borde | **Confirmado**: a 320 el diálogo mide `[0,16,320,552]`, gutter 0 en los dos lados, caja de contenido **272 px** (= 320 − 48) |
| R27 — el cajón mide 288 px fijos | **Confirmado**: `drawerWidth=288` en los tres anchos. A 320 el cierre llega a 272 y los 9 enlaces entran sin quedar cubiertos — el problema del cajón **no es la geometría, es el comportamiento** |
| R11/R14 — blancos táctiles | **Confirmado**: primarios de **36 px**, ghost de **38**, iconos de **40**, contra el objetivo móvil de 44. Y el censo de los botones-subrayado de 20 px, que son muchos más de los que parecían: **20 en Empleados, 50 en Roles, 22 en Caja, 15 en Vales, 6 en Métodos, 2 en Impuestos** |
| R13 — la casilla | **Confirmado**: 16×16 px medidos |
| R3/R4/R19 — acciones de fila fuera de pantalla | **Confirmado**: la primera acción queda en `left` **409 / 619 / 676** contra anchos de 390 / 360 / 320, y hay **20 botones fuera en Empleados, 4 en Servicios y 6 en Inventario** esperando un scroll horizontal de la tabla |
| R17 — relleno lateral fijo | **Confirmado en sustancia, con la cita corregida**: `app/page.tsx:52` es una entrada del arreglo `MODULES`, no una clase. La clase vive en **`src/components/ui/lib/page.tsx:39`** y mide 24 px por lado sin escalón |

### Refutado o parcial (y por qué importa)

- **R8 (`vh` vs `dvh`) — no observable.** En este Chromium headless `100vh == 100dvh == innerHeight`
  en los tres anchos, así que el riesgo de la barra del navegador **no se puede medir acá**. El código
  sí usa `vh` y el estándar del repo pide `dvh`, pero **no hay número que lo pruebe en escritorio
  headless**: queda como corrección justificada por la regla, no por la medición.
- **El icono de 32 px no existe**: `ui-styles.ts:24` es `ghostClass` y mide **38 px**. La predicción de
  «32 px» queda refutada; el piso de 44 sigue sin alcanzarse, pero por 36-40 y no por 32.
- **R23 (guarda de `overflow-x` en `body`) — innecesaria hoy**: **no hay desborde horizontal de
  página** en ninguna ruta ni ancho (`documentElement.scrollWidth == innerWidth` en home, admin,
  services, inventario, alertas y kardex). Los anchos grandes son tablas **dentro** de su carril
  (admin 494, services 640, inventario 760, kardex 520 contra carriles de 238/222/238). El carril
  contiene bien: la guarda global queda como defensa, no como defecto.
- **Cero controles tapados por UI de la aplicación** en 5 rutas × 3 anchos. El único caso medido es
  `nextjs-portal` —el indicador de desarrollo de Next— tapando un radio de 13 px: **artefacto de dev,
  no de la app**.

### Nuevo, y es de los peores: R32

**El pie de los formularios no es pegajoso, así que guardar y cancelar quedan bajo el pliegue.**
Medido en *Nuevo empleado* a 320: el contenido del diálogo mide **1527 px** contra **534 px** de caja,
y los botones quedan en `y≈1438-1520` contra un viewport de **568**. O sea: **hay que scrollear dentro
 del diálogo para poder guardar**. Confirmado también a 390.

| # | Pantalla | Síntoma | Causa |
| --- | --- | --- | --- |
| R32 | **todos los formularios largos** | La acción primaria y Cancelar quedan fuera de la caja del diálogo y exigen scroll interno | `src/components/ui/lib/form-dialog.tsx:198` — pie **no pegajoso** |

Es una **primitiva**, no una pantalla: paga en todos los formularios.

## Tasks

Pendientes de la decisión del dueño sobre el alcance, ordenadas por la regla de primitivas primero:

- [ ] **R-a — las primitivas compartidas**, que es donde cada corrección paga en todas las pantallas:
      el cajón al `Dialog` de Radix (R2, medido roto por tres vías), el **pie pegajoso** de
      `form-dialog` (R32, medido), el margen y el `dvh` del diálogo (R7 medido, R8 por regla), el
      tamaño de los campos (R22: 14 px hace zoom en iOS y quedan en 37), los tokens de
      `ui-styles` (R11 medido con censo de ~115 subrayados, R14 medido en 36-40), la casilla (R13,
      16 px medido), el combobox (R9) y el `Select` (R21) **si su medición lo confirma**.
- [ ] **R-b** — las acciones fuera de pantalla: inventario (R1), admin/servicios/inventario (medido:
      20/4/6 botones), caja (R3), vales (R4), nómina (R5, R6).
- [ ] **R-c** — el resto de la copia visual (R10, R12, R16, R17→`page.tsx:39`, R19, R20) y los
      tooltips que en touch no existen (R25, R26), que no son cosméticos aunque lo parezcan.
- [ ] **R-d** — la segunda medición, con datos, después de la prueba de humo.

## Pendiente de medición

- **R21 (el `Select` atado a la altura del disparador)** y **R9 (el combobox recortado)**: los mide la
  pasada de primitivas. R21 decide si existe una unidad entera.
- **R5, R6, R3, R4** con filas reales: la medición de las tablas anchas no se puede hacer con la base
  vacía.

## Qué NO se pudo alcanzar sin crear datos

- **No existe un diálogo «nuevo usuario»**: crear un usuario de acceso es una casilla dentro de
  *Nuevo empleado* (`employees-section.tsx:512`), y la pestaña **Roles** sólo asigna rol y
  restablece clave.
- **«servicios» no es sección de `/admin`**: es la ruta `/services`, que sí se midió. Las pestañas
  reales son Empleados, Roles, Impuestos, Métodos de pago, Vales y Caja.
- **No se abrieron** las variantes *Editar* de producto, servicio, empleado, impuesto y método, las
  confirmaciones de borrado, ni nada de caja, facturas, pagos, nómina o vales: requieren registros
  concretos. Los artefactos están en `~/ui-audit/` (96 capturas, `report.json`).

## Route declaration

Auditoría **de sólo lectura** sobre código y sobre la aplicación corriendo. No muta datos de la
aplicación: la única escritura es la sesión efímera de prueba. Los arreglos son una unidad aparte y
no se mezclan con la nómina.
