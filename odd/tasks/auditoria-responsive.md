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

### Segunda medición: las rutas del dinero

Con datos reales ya en la base (turno abierto, 2 facturas cobradas, 1 vale aprobado), 12
combinaciones ruta × ancho, sin mutar nada. **Cero desborde horizontal de página** otra vez.

| # | Pantalla | Síntoma medido | Causa |
| --- | --- | --- | --- |
| R33 | `/invoices` | **No se puede emitir una factura en un teléfono.** El diálogo de emisión mide **870 px de ancho** dentro de un modal de 320-390: el botón de envío queda en `x 713-846`, fuera de pantalla, y llegar a él exige scrollear el modal a lo ancho ~400-550 px. `scrollHeight 1005` contra `clientHeight 536` | `invoices-client.tsx:1449` (`min-w-[820px]`) + `:1936` (grilla de 9 columnas) |
| R34 | `/payroll` | La acción primaria del diálogo queda **bajo el pliegue**: en «Abrir período» el contenido mide **1332** contra **534** de caja y «Crear» está en `top 1243`; en «Registrar pago extraordinario», 942 contra 534 y el botón en `top 853` | `payroll-client.tsx:2767` y `:2569` |
| R35 | **todos los diálogos** | **Ningún diálogo tiene control de cierre visible**: se cierran sólo con Cancelar o Escape, y **en un teléfono no hay tecla Escape** | medido en los 7 diálogos abiertos |
| R36 | `/invoices` | Dos botones de pie miden **22 px** de alto; el selector de comisión de ítem computa **10 px** de tipografía y **23 px** de alto | `invoices-client.tsx:1687,1718` y `:231` |
| R37 | `/invoices`, `/vales` | **El combobox recortado queda CONFIRMADO con número**: la lista mide `bottom 771` contra `bottom 655` del contenedor que lo recorta (116 px cortados a 390), **no voltea hacia arriba** (`flipUp false`), son 10 opciones y las de abajo **son inalcanzables**. El `Select` hermano **sí** portalea (`inDialogDom false`): la inconsistencia es real y tiene un objetivo concreto | `combobox.tsx:122` vs `select.tsx:81-89` |

**Refutado en esta pasada**: R10 — a 320 el botón «Personalizado» se sale de su caja por **2 px**, sin
partirse ni derramar (`scrollHeight == clientHeight`). Es cosmético, no un defecto de layout.

**Matizado**: los 6 radios de ciclo de nómina miden 13×13, pero **la etiqueta que los envuelve es el
blanco real**, así que el defecto es menor de lo que parecía por tamaño.

**Bloqueado por falta de datos**: la predicción de R5 (la tabla del borrador de 1040 px dentro del
diálogo) necesita **un período de nómina**, y no hay ninguno: `DraftPayrollTable` sólo se renderiza
con el detalle del período abierto. El mecanismo está en el código, la medida no se pudo tomar.

## Cómo se presenta la data (criterio del dueño, 2026-10-04)

> *«Hay que tener muy en cuenta el cómo se ve la data en tablas, listas, etc., para que no quede
> arrumada, sino que pueda usar bien el espacio.»*

Esto **no es un criterio de estética: es el que decide el alcance**. Hasta acá la auditoría midió «¿el
control es alcanzable?». Este criterio agrega «¿la data se lee bien en ese ancho?», y las dos
preguntas tienen respuestas distintas: una tabla de 1100 px **contenida en un carril con scroll**
tiene todos sus botones alcanzables y aun así está arrumada — hay que arrastrar de costado para
saber cuánto se vendió.

### El estado declarado del repo

El comportamiento actual **no es un descuido: es una decisión vieja y escrita**. `docs/ux-ui-standard.md`
§5 dice *«En móvil, la tabla se desplaza | No se apilan columnas todavía: es deuda consciente (§9)»* y
§12 la repite como deuda conocida. **Este criterio la paga**, así que la unidad que la implemente
también **corrige el estándar y su test**: `ux-data-table.test.ts` hoy **exige** que los `min-w-[Npx]`
vivran dentro del primitivo, con una allowlist exacta de la deuda.

### El contrato que se adopta

**El criterio es global y verificable; el mecanismo se elige por lista.** No todas las listas son
iguales: una tabla de 4 filas de impuestos no necesita lo mismo que las 20 filas de facturas del día.

**Criterios de aceptación — medidas, no opinadas:**

1. **Nada importante requiere un gesto horizontal.** El dato que identifica la fila (nombre, número)
   y el dato de dinero o estado **se ven sin arrastrar**, en 320 px.
2. **La acción de la fila se ve y se toca sin arrastrar.** Es lo que hoy falla en vales (674 px fuera)
   y en caja (1100 px) y en el admin (20 botones fuera).
3. **El espacio vertical es el que se usa.** Un teléfono tiene alto de sobra y ancho de menos: la
   forma natural de una fila en mobile es **una tarjeta con pares etiqueta/valor**, no una tabla
   apretada ni una columna escondida.
4. **Nada de dato importante vive en un tooltip.** El `title=` **no existe con el dedo** (R25, R26):
   un texto recortado necesita su lectura dentro de la pantalla, no en un hover.
5. **Densidad declarada, no accidental.** Cada lista dice **qué columnas se ven en qué ancho**; ninguna
   pierde una columna por accidente del `min-w`. Y una sola escala de anchos: **cero `min-w-[Npx]`
   fuera del primitivo**.

### El mecanismo, por lista

| Lista | Forma en mobile | Por qué |
| --- | --- | --- |
| Facturas, vales, caja, nómina | **Tarjeta por fila** | Son las listas que se leen y se accionan en el mostrador: muchas filas, dinero y estado, y una acción por fila |
| Admin (empleados, usuarios, roles), inventario, servicios | **Prioridad de columnas + carril** | Listas de consulta y edición, con menos filas y sin una acción dominante por fila: 3-4 columnas declaradas y el resto al detalle |
| Impuestos, métodos de pago, denominaciones | **Como están** | 2-6 filas de 3 campos: no hay nada que apilar |

**Lo que se construye una sola vez, en las primitivas**: la tarjeta de fila (para que las cuatro
listas de dinero se vean igual), el carril con la **acción pegada** al borde, la declaración de
prioridad de columnas y los tokens de tipografía y alto de fila. Cada lista de dinero **no** debe
inventar su propia tarjeta.

### Por qué no se toca todo de una

Son **11 pantallas y 14 tablas**: una sola unidad sería exactamente el cambio enorme de varias áreas
que hay que evitar. Va **encadenada por lista**, empezando por las que el mostrador usa en un
teléfono (facturas, vales, caja), y el estándar se corrige **en la misma unidad** que la primitiva,
no al final.

### Tercera medición: las primitivas — tres predicciones caídas

De siete predicciones, **tres se cayeron y dos se angostaron**. La lectura de código encontró el
mecanismo; **sólo la medición dijo si el mecanismo se manifiesta**.

**R21 — REFUTADA, y era la que yo había señalado como la de mayor alcance.** El `Select` **no está
roto**: `--radix-select-trigger-height` computa 40 px, el viewport mide **208 / 208 / 268 / 228** en
los cuatro anchos, las **4 opciones se ven enteras en los cuatro**, el viewport no scrollea
(`scrollHeight == clientHeight`), cada opción se devuelve a sí misma en `elementFromPoint` y hacer
clic en la última cambia el valor del disparador. **Mecanismo**: Radix pone `flex: 1 1 0%` **inline**
en el Viewport y eso gana sobre la clase `h-[var(--radix-select-trigger-height)]` — la clase es un
**no-op** (forzando `flex: none` el viewport mide exactamente 40 px). Mi lectura del código era
correcta y mi conclusión era falsa, por una interacción de especificidad. **No hay unidad que crear.**

**R15 — REFUTADA.** No hay scroll fantasma: en `/alerts`, `/services` y `/vales` a 390 el
`scrollHeight` es 907 contra 844, y forzando `min-height: 0` **sigue siendo 907**: los 63 px son
contenido real, no el `min-h-screen`.

**R28 — REFUTADA donde se pudo medir.** La fila de paginación de facturas mide 222 = 222 y las filas
de caja 125 = 125, sin desborde. Las de alertas y la paginación de inventario no se renderizaron
(sin datos): no verificadas, no refutadas.

**R37 — MATIZADA.** A 320 la lista se sale del diálogo **98 px**, no voltea y no portalea — pero **la
última opción sí es alcanzable** después de scrollear el diálogo, porque la propia lista agrega ese
rango al scroll. No es inalcanzable: es incómodo. Baja de severidad, no desaparece.

**R1 — CONFIRMADA, más angosta de lo que la lectura decía.** La colisión es real **sólo a 320×568**:
la barra se pega en `top 0..114`, el encabezado ocupa `0..63`, y `elementFromPoint` en el centro de
«Crear producto» devuelve el título «Orabella» — **no es clickeable**. A 360 y 390 no hay scroll
suficiente para llegar a ese estado.

**R32 — CONFIRMADA, y ahora con alcance**: en **tres** diálogos hay que scrollear para guardar.
«Crear producto» no llega a 360/320 (819 > 606/534); **«Nuevo empleado» no llega en ningún ancho**
(1471-1527); **«Emitir factura» tampoco** (1005). «Registrar movimiento» sí entra.

**R22 — CONFIRMADA, y es peor de lo que parecía**: los campos miden **14 px** (bajo el umbral de 16 que
dispara el zoom de iOS) y **38-40 px de alto**; el botón primario 36; la casilla 16×16. Y el piso de 44
**no es un problema de mobile**: a 1024 hay 22 elementos interactivos y **los 22 están bajo 44**. Es una
decisión de densidad de toda la aplicación, no un defecto de ancho.

**R7 — CONFIRMADA**: gutter 0 a 320/360/390 — y **también a 1024** en el diálogo de emisión (`p-0`,
1024 de ancho, gutter 0 en los dos lados).

## El defecto que la medición no podía ver (R38)

**Lo encontró el ojo del dueño, no un instrumento.** En facturación, a 412×924 —y en cualquiera de
los tres anchos que se midieron, porque 412 también queda por debajo de `sm`— la lista **no muestra
una tabla con scroll: muestra nueve valores apilados sin una sola etiqueta**.

El encabezado que nombra cada columna es `hidden … sm:grid` (`invoices-client.tsx:1936`) y cada fila
es `flex flex-col … sm:grid` (`:1952`). Resultado: `#12`, `03/10 16:41`, `Carolina Rojas`, `—`, `—`,
`Carolina Rojas`, `$120.000`, `Pagada` y los botones, **en ese orden y sin decir qué es cada cosa**. ¿La
primera fecha es la de emisión o la de cierre? ¿El primer nombre es la vendedora o la que cerró?

**Es el opuesto exacto del «arrumado» que el dueño describió, y es peor**: apilar no es el problema —es
lo que el contrato pide— pero apilar **sin etiquetas** deja la data ilegible. La fila ya está 80 %
construida: sólo le faltan los pares etiqueta/valor.

### Por qué la auditoría no lo vio

Los instrumentos de medición de todo el día fueron **geometría**: desborde, controles tapados
(`elementFromPoint`), recortes, blancos táctiles. Este defecto **no produce ninguna de esas cuatro
cosas**: no hay desborde (¡apila en vez de desbordar!), ningún control queda tapado, nada se recorta
y los blancos están bien. Las 100+ capturas que se tomaron **incluyen** este estado y nadie las miró
como las mira una persona. La lección: **una métrica mide lo que mide; la legibilidad de la data
necesita su propio criterio**, y el criterio del dueño («cómo se ve la data») es el que lo trajo.

### Lo que cambia en el plan

1. **Facturas deja de ser «convertir a tarjeta» y pasa a ser «terminar la tarjeta que ya es»**: agregar
   el par etiqueta/valor a cada campo apilado, con la etiqueta visible sólo por debajo de `sm` (arriba
   el encabezado ya las nombra).
2. **Facturas es la REFERENCIA, no el caso raro**: es la única lista de la app que ya apila (las otras
   seis son `<table>` con scroll), así que la pieza reusable sale de terminar ésta y no de inventarla.
3. **Un criterio de aceptación nuevo, verificable**: cada valor apilado tiene su etiqueta visible por
   debajo de `sm`. Se puede afirmar en un test sobre el marcado, así que deja de depender del ojo.
4. **Las otras seis listas** (caja, vales, admin, inventario, servicios, nómina) siguen el camino
   conocido: hoy son tablas con carril y scroll, y van encadenadas después.

### Medición de cierre — todo confirmado, con números

Verificado **en navegador sobre la base con datos reales**, en 412×924 —el viewport del dueño, donde
reportó el defecto—, 390×844, 360×640, 320×568 y 1024×768:

| Qué | Número |
| --- | --- |
| Las nueve etiquetas a 412 | **9 de 9 visibles y ningún valor sin la suya.** El orden de lectura es el de la tarjeta aprobada |
| ¿Se dibujan de verdad? | Sí: `display:inline`/`block` con rect > 0 en los cuatro anchos angostos, y **`display:none` a 1024**, donde el encabezado ya nombra las columnas |
| Equivalencia de escritorio | Coordenadas de los nueve valores `[318,366,494,523,553,681,714,810,890]` contra las de los nueve encabezados `[319,367,495,524,552,680,713,809,889]`: **deltas de 1 px o menos**, cada valor bajo el encabezado que lo nombra |
| Acciones alcanzables | `elementFromPoint` devuelve el botón en **412 y en 320** (y en los otros tres anchos) |
| Gesto horizontal | Ninguno: `scrollX=0` y `scrollWidth == clientWidth` en la fila **y** en la página, en los cinco anchos |
| Gate | 12/12 en la guarda nueva, **1990 en 38 archivos**, typecheck y eslint limpios |

La lectura real a 412×924, que es lo que el dueño pedía ver:

```
ID: #2                  Fecha: 4/10 04:45 p. m.
Total: $ 100.000                  Estado: Pagada
Abrió: Carolina Rojas
Empleados: Andrés Quintero
Acciones:  [Editar] [Ver detalle]
Cerró: Carolina Rojas   Cerrada: 4/10 04:45 p. m.
```

### Follow-ups que dejó la verificación (R38)

1. **La guarda mira el MARCADO, no el render** — probado con una sonda: agregarle `hidden` o `sr-only`
   a una etiqueta la deja **invisible en todos los anchos y el test sigue verde**. Son **tres sitios**
   con el mismo punto ciego (dos aserciones decorativas y el tope de razonamiento sobre `sm:hidden`), y
   se arreglan con **una sola corrección lógica que toca dos aserciones**: un predicado por línea móvil
   que exija la etiqueta visible y **rechace cualquier clase que la colapse**. Va **antes de reusar la
   guarda en las otras listas**, para no clonar una guarda que no mira lo que dice mirar.
2. **Cosmético a 320**: el envoltorio de Total/Estado mide 48 px con `flex-wrap:nowrap`, así que el
   `Badge` de estado se envuelve debajo de su etiqueta y «Estado» queda leyéndose arriba de «Total».
   Nada se desborda y las acciones siguen respondiendo: es pulido, no defecto.
3. **Decisión de vocabulario pendiente del dueño**: las etiquetas usan las palabras del encabezado
   (`Abrió`, `Cerró`), que no son las del mock que se le mostró (`Vendedor`, `Cerrado por`). Si prefiere
   las amigables, son nueve textos — y hay que aflojar a propósito la aserción del juego de palabras.

## Tasks

El orden no es por severidad aislada: **el contrato de data va antes que los arreglos de acciones de
fila**, porque arreglar «la acción quedó fuera de pantalla» ensanchando el carril y después volver a
hacerlo como tarjeta sería pagar dos veces las mismas pantallas.

- [ ] **R-a — las primitivas compartidas**: el cajón al `Dialog` de Radix (R2: Escape no cierra, el
      foco se escapa al decimosegundo tabulador, el fondo scrollea y el foco no se restaura), el **pie
      pegajoso** de `form-dialog` (R32: medido en «Nuevo empleado», «Emitir factura» y «Crear
      producto»), el margen y el `dvh` del diálogo (R7 medido con gutter 0, R8 por regla), el tamaño de
      los campos (R22: 14 px y 38-40 de alto, con el piso de 44 incumplido **también en escritorio**),
      los tokens de `ui-styles` (R11 medido con censo de ~115 subrayados, R14 medido en 36-40), la
      casilla (R13, 16 px medido) y el combobox (R37, medido y matizado: no portalea ni voltea).
      **Fuera de esta unidad, por refutadas**: R21 (el `Select` **no** está roto) y R15 (no hay scroll
      fantasma).
- [ ] **R-e — el contrato de presentación de data**: corregir el estándar (§5 y §12 hoy declaran el
      scroll como deuda consciente), construir **una sola vez** las piezas reusables (tarjeta de fila,
      carril con la acción pegada, prioridad de columnas, tokens de alto de fila) y estrenarlas en la
      **primera lista**: facturas — que no es «convertir a tarjeta» sino **terminar la tarjeta que ya
      es** (R38: agrega el par etiqueta/valor a cada campo apilado, con la etiqueta visible sólo por
      debajo de `sm`). El test que hoy exige `min-w-[Npx]` dentro del primitivo se actualiza junto con el
      estándar, no después, y se agrega el criterio verificable de que **ningún valor apilado queda sin
      etiqueta**.
- [ ] **R-e2 — las otras dos listas de mostrador**: vales y caja, con las piezas de R-e ya construidas
      (que es lo que hace que las tres se vean igual).
- [ ] **R-b — los diálogos que no dejan operar**: el de emisión de factura (R33: **870 px dentro de un
      modal de 320** — el peor del informe), los de nómina con la acción bajo el pliegue (R34), el
      cierre visible que no existe (R35) y las acciones de fila del admin, inventario y servicios
      (medido: 20/4/6 botones fuera).
- [ ] **R-c — lo que se ve mal o no se puede leer**: el resto de la copia visual (R12, R16→R36,
      R17→`page.tsx:39`, R19, R20) y, sobre todo, **la data que vive en tooltips** (R25, R26), que con
      este criterio deja de ser cosmética: es data que en un teléfono no se puede leer.
- [ ] **R-d — la tercera medición**, con un período de nómina, para cerrar R5, R6 y verificar el
      contrato de data con filas reales.

## Pendiente de medición

- **R5 y R6** con un período real: el detalle de período necesita que exista al menos uno.
- **R28** en alertas y en la paginación de inventario: no se renderizaron por falta de datos.
- Lo que la medición headless **no puede** ver: el efecto real de la barra del navegador
  (`100vh == 100dvh == visualViewport.height` en los 16 casos, así que R8 se corrige por la regla del
  repo y no por una medición).

## Qué NO se pudo alcanzar sin crear datos

- **No existe un diálogo «nuevo usuario»**: crear un usuario de acceso es una casilla dentro de
  *Nuevo empleado* (`employees-section.tsx:512`), y la pestaña **Roles** sólo asigna rol y
  restablece clave.
- **«servicios» no es sección de `/admin`**: es la ruta `/services`, que sí se midió. Las pestañas
  reales son Empleados, Roles, Impuestos, Métodos de pago, Vales y Caja.
- **Lo que falta para cerrar la medición**: un **turno cerrado** (con nota de revisión o reconteo) para
  que aparezcan `Ver`/`Recontar`/`Versiones`; un vale en estado **`pendiente`** para que aparezcan
  `Aprobar`/`Rechazar`; y un **período de nómina** para el detalle y su tabla de borrador. Todo eso lo
  produce la prueba de humo del dueño.
- No se abrieron las variantes *Editar* ni las confirmaciones de borrado. Los artefactos están en
  `~/ui-audit/`.

## Estado final de la jornada

**Las siete listas de dinero y administración dejaron de esconder sus acciones**, cada una medida en
navegador a 320/360/390/412 (y 640/768/1024 donde la grilla de escritorio importa):

| Lista | Valores con etiqueta | Acciones fuera de pantalla | Scroll lateral |
| --- | --- | --- | --- |
| Facturas | 9/9 | 0 (era 1) | 0 |
| Vales | 6/6 | 0 (era 1, a 674 px) | 0 (era un carril de 522 px) |
| Servicios | 20/20 | **0 (eran 4)** | 0 |
| Inventario (2 listas) | 27/27 y 5/5 | **0 (eran 6)** | 0 |
| Admin (empleados, usuarios) | 60/60 cada una | **0 (eran 20 cada una)** | 0 (era 256/347 px) |
| Caja | en medición | en medición | en medición |

**Y cinco hipótesis se cayeron al medirlas**, que vale tanto como los arreglos: el `Select` atado a la
altura del disparador (Radix pone `flex` en línea y la clase es un no-op), el scroll fantasma del
`min-h-screen` (los 63 px eran contenido real), el hazard del `max-w` (el merge elimina al competidor),
el recorte de 38,5 px del papel (el diálogo scrollea; al fondo el borde cae exacto sobre la caja) y el
ancho del matcher que abría `/v1.2/payroll` (era un defecto del arreglo propuesto, no del entregado).

**Lo que quedó sin medir, declarado**: el antes/después de caja (su informe nunca llegó, hay una
medición en curso), los botones de aprobar/rechazar de vales (necesitan un vale **pendiente**, que la
base no tiene), el seed de humo (**ningún test lo lee**: lo verificado es su texto, no su efecto), el
`dvh` (indistinguible en headless) y los tres cambios de la fila de facturas del último tramo (la lista
sale vacía en vivo porque el filtro es por hoy y los datos de humo son de ayer: se midieron sobre un
nodo réplica con la clase efectiva, y así está rotulado).

### Lo que se sumó después del primer cierre

**Una regresión la introdujo nuestro propio arreglo, y la cazó la verificación siguiente.** El arreglo
de caja reordenó las celdas al orden de lectura del teléfono y dejó el encabezado en el orden viejo. En
una tabla las celdas se colocan **por posición en el DOM, no por nombre**, así que en escritorio **12 de
17 columnas** quedaron con la palabra equivocada arriba (`decía Estado` / `el valor era Jorge Ramírez`),
todas con **0 px de desviación**: el valor estaba en una columna, en la equivocada. Corregido a **0 de
17**, y la guarda pasó a comparar **secuencias** en vez de conjuntos — que era exactamente por lo que no
podía verlo.

**El combobox era inconsistente consigo mismo**: su filtro ya estaba en 44 px y 16 px debajo de `sm` y
el disparador seguía en 40/14 y las filas de opción en 36/14, medido en dos comboboxes reales a 320, 640
y 1024. Los tres llegan al piso debajo de `sm` y el escritorio quedó **byte a byte igual**. Y quedaron
dos elementos **debajo del piso a propósito**, con el criterio escrito en la guarda: el estado vacío (es
texto para leer, no un blanco para tocar — no es un botón, no tiene tabindex, nunca recibe foco) y la
descripción de la opción (metadato secundario dentro de una fila que ya está en el piso). **El piso
aplica a lo que se toca, no a todo lo que es chico.**

**La copia que prometía un mecanismo inexistente: cinco defectos de la misma clase**, y cada arreglo
destapó el siguiente. En el cliente: la descripción del diálogo («No hay fechas que escribir», falso en
la primera liquidación), la leyenda (nunca decía que la ventana de fechas pertenece al **ciclo
elegido**), el texto del rango, y los dos mensajes de solape («Ajuste las fechas o la cadencia»). En el
**servidor**: tres rechazos de `PERIOD_OVERLAP` que decían lo mismo y **llegan a ese mismo diálogo** por
`${result.code}: ${result.message}`. Los cinco mandan ahora a lo que el diálogo **sí** deja hacer:
elegir otro ciclo. La clase quedó con **cero ocurrencias** en las dos superficies.

Y un detalle que vale como lección de consistencia: al unir la razón y el remedio con dos puntos, el
remedio quedaba en minúscula y **rompía el literal que el cliente comparte** — lo cazó la prueba que el
propio autor había escrito, y lo obligó a separarlos en dos oraciones.

**La última clase de copia, en los módulos que nadie había barrido**: **diez cadenas** en facturación y
comisiones — las cinco del inventario y **cinco más que encontró el re-barrido** —, cada una decidida
leyendo la consulta detrás de la frase: los métodos de pago pasan a «en la instalación» (el catálogo se
lee sin predicado y la 074 le quitó la sede a la restricción), los «no encontrado en esta sede» pierden
un alcance que ninguna consulta aplica, y los avisos de lectura incompleta pasan a «de la instalación».
Con **cinco guardas nuevas** (código, estado, literal, la negativa de que la palabra aparezca y la
afirmación de que no se escribió nada).

**Suite al cierre: 2357 pruebas en 48 archivos, todas verdes.**

### Lo que esta unidad NO cierra, y lo que hay que no confundir

**El flujo de nómina tiene un defecto estructural que esta auditoría no vio, y lo encontró otra sesión.**
Con **piso único + recorte**, y con las tres cadencias cerrando el mismo sábado, **toda** cadencia cuyo
ciclo contenga el piso produce el mismo rango `(piso, últimoSábado)`: la primera liquidación de dos o más
cadencias **colisiona siempre** (`PERIOD_OVERLAP` / `PERIOD_DRAFT_EXISTS`), medido contra los datos
reales. Su plan — *anclaje por cadencia*, cada grupo con su propia línea de tiempo — está en
`odd/tasks/nomina-anclaje-por-cadencia.md`, que **no es de esta unidad**.

**Y la lección de método es para esta auditoría**: mi verificación de la unidad de nómina confirmó, una
por una, las **reglas** del diseño (el piso derivado, la fecha declarada, el recorte, las tres
validaciones) y dio todas por buenas — porque verificó **reglas**, no la **interacción** de tres cadencias
sobre la misma grilla. **Un conjunto de reglas correctas puede producir un sistema roto**: el defecto
vive en el cruce, y ningún test de reglas lo iba a mostrar.

**Parkeado, con dueño pendiente** (no se perdió, se dejó de hacer a propósito):
- El **inventario del README del módulo de nómina** (prosa de la capa retirada, tablas a las que ya no
  les existe la columna de sede, el `EXCLUDE` sin ese elemento), cuyo arreglo se **revirtió** por
  pertenecer al área que otra sesión está trabajando.
- El **residuo de comentarios** del mismo tipo en `billing/service.ts:928-929,969-970` y
  `commissions/service.ts:364,414,500`: son comentarios, no copia de usuario, y no los fija ningún test.
- Los **botones de aprobar y rechazar de vales**: siguen sin medición directa porque la base no tiene
  ningún vale en estado `pendiente`.
- La **deuda declarada en la base**: el rol `superadmin` y la columna `sedes.payroll_start_date`, que se
  borran en el próximo reset y que hoy tienen una guarda que impide que los borren «de paso».

## Hazards reportados y refutados

**«La base del diálogo lleva `max-w-lg` sin variante, así que un llamador con `max-w-sm` podría
recibir 512 en vez de 384.»** Lo reportó el writer que arregló el criterio de ancho, correctamente
marcado como *no medido*, y **quedó refutado por tres vías independientes**:

1. **El merge elimina al competidor.** `DialogContent` compone sus clases con `cn()`, que es
   `twMerge(clsx(...))` (`src/components/ui/lib/utils.ts`): el `max-w-lg` de la base y un `max-w-*`
   del llamador son el mismo grupo, así que **nunca conviven en la lista de clases** y no hay empate
   posible en la hoja. El propio informe decía «twMerge deja solo el token del llamador» y a
   continuación concluía que la base ganaría: **la premisa refuta la conclusión**.
2. **Prueba empírica que ya existía**: el diálogo de inventario pasa `max-w-2xl` y **midió 672 px**
   en la auditoría — ganó el valor del llamador, no el de la base.
3. **Y aun en un empate imaginario ganaría el llamador**: el orden de la hoja compilada (69 KB
   servidos por el dev server) pone `.max-w-lg` en el byte **17603** y `.max-w-sm` en el **17752**,
   o sea que la regla más chica se emite **después** y gana a igual especificidad. La premisa
   «Tailwind v4 emite `max-width` de menor a mayor» es **falsa**: el orden observado es
   `2xl, 4xl, 5xl, lg, md, sm, xl`.

⇒ **No hay nada que arreglar en `dialog.tsx`.** Queda asentado para que nadie «arregle» un defecto
que no existe — que es el mismo trabajo que encontrar los que sí.

## Route declaration

Auditoría **de sólo lectura** sobre código y sobre la aplicación corriendo. No muta datos de la
aplicación: la única escritura es la sesión efímera de prueba. Los arreglos son una unidad aparte y
no se mezclan con la nómina.
