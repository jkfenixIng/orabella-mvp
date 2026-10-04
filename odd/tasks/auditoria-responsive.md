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

**En curso** (dos agentes con shell, la pasada estática no puede manejar navegador: `explore` no
tiene ejecución). Confirmarán o refutarán cada predicción con un número.

**Límite conocido y declarado**: PRUEBAS tiene **cero turnos, cero facturas, cero vales y cero
períodos**, porque eso es justamente lo que crea la prueba de humo del dueño. Con las tablas vacías,
el estado vacío **tapa** los defectos de tabla: R3, R4, R5, R6 y R19 no se pueden medir de verdad
hasta que existan datos. **Segunda pasada de medición después de la prueba de humo** — que es la que
va a medir las tablas con filas reales.

## Tasks

Pendientes de la decisión del dueño sobre el alcance, ordenadas por la regla de primitivas primero:

- [ ] **R-a** — las primitivas compartidas: diálogo (R7, R8), combobox (R9), caja (R13), tokens de
      `ui-styles` (R11, R14), `checkbox` (R13) y la carcasa (R2, R15, R18). Una unidad, porque cada
      corrección paga en todas las pantallas.
- [ ] **R-b** — las acciones fuera de pantalla: inventario (R1), caja (R3), vales (R4), nómina (R5,
      R6).
- [ ] **R-c** — el resto de la copia visual (R10, R12, R16, R17, R19, R20).
- [ ] **R-d** — la segunda medición, con datos, después de la prueba de humo.

## Route declaration

Auditoría **de sólo lectura** sobre código y sobre la aplicación corriendo. No muta datos de la
aplicación: la única escritura es la sesión efímera de prueba. Los arreglos son una unidad aparte y
no se mezclan con la nómina.
