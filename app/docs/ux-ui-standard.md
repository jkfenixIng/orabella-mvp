# Estándar de desarrollo UX/UI — Orabella

Este documento decide **casos**, no enuncia deseos. Si tuviste que elegir algo
de interfaz y no está acá, es una laguna del estándar: agregala, no la resuelvas
solo en tu archivo.

Su razón de ser es concreta: el mismo problema ya se resolvió de tres maneras
distintas en tres lugares, y el costo lo paga quien revisa y quien usa. La
consistencia en este repo no se sostiene con buena voluntad, se sostiene con un
test que falla (§10).

> **Estado de este documento.** La capa de color, tokens, `Badge` y el criterio
> `Alert`/toast ya está implementada y guardada: acá se **documenta como
> congelada**. Las secciones marcadas **«nuevo»** describen primitivos que este
> estándar introduce; mientras uno no exista todavía, no lo uses.

---

## Ruta rápida

Vas a agregar una pantalla o una acción. Los tres pasos son siempre estos:

1. **Elegí la superficie** en la tabla de §1. Es la decisión que más se equivoca.
2. **Armá la página** con `PageContainer` + `PageHeader` (§2). Nunca escribas el
   wrapper ni el `<h1>` a mano.
3. **Pasá el checklist de §11** antes de pedir revisión.

---

## 1. Tabla de decisión de superficie

Es la regla que hoy falta. El mismo tipo de acción se resuelve con diálogo en
Empleados, Roles y Vales, y con un formulario inline pegado a la lista en
Impuestos, Métodos y Caja (`admin-sections/{taxes,methods,cash}-section.tsx`).

| Necesidad | Superficie | Componente | ARIA |
|---|---|---|---|
| **Tarea primaria** de la página (para eso entró el usuario) | Inline, en el cuerpo | — | — |
| **Crear o editar un ítem de un listado** | Diálogo | `FormDialog` | título obligatorio |
| **Confirmar algo destructivo o irreversible** | Diálogo | `ConfirmDialog` | título + descripción |
| **Ver un recurso y volver** | Diálogo de solo lectura | `Dialog` | título obligatorio |
| **Confirmar algo reversible de 1 clic** | En línea, en la propia fila | — | — |
| **Aviso de lo que ES el caso** (sigue vigente hasta que algo cambie) | Inline y persistente | `Alert` | derivado de la variante |
| **Evento que acaba de pasar** | Toast, efímero | `toast` (sonner) | `status` |
| **Lista o tabla vacía** (baseline esperado) | Texto apagado | `EmptyState` | **sin** `aria-live` |
| **Navegar entre secciones de una misma página** | Pestañas | `Tabs` | `tablist` + `tabpanel` |
| **Mostrar datos tabulares** | Tabla con scroll | `DataTable` | — |

### Las dos reglas que se derivan

**a. Una lista nunca convive con el formulario de creación pegado debajo.**
Eso deja dos tareas primarias en la misma pantalla, hace saltar el alto de la
lista cada vez que alguien entra o sale del modo edición, y obliga a hacer
scroll mental para relacionar el formulario con la fila que se está editando.
Si crear o editar es una acción **secundaria** del listado —lo es en Impuestos,
Métodos y Caja— va a un `FormDialog`.

**b. Inline es para lo primario, y se gana el lugar.**
En Facturación el compositor de la factura, y en Vales la solicitud, SÍ son la
tarea primaria: ahí inline es correcto. Pero se justifica por eso, no por
costumbre.

### Un hecho, un canal

Nada se anuncia por dos vías. Si el éxito de una acción es un evento, sale por
toast **y** no se deja además un texto pegado en pantalla. Si es un estado, va
por `Alert` y no dispara un toast.

Detalle fino ya decidido: un aviso que se **deriva en vivo** mientras el usuario
escribe (no el desenlace de una acción enviada) usa la presentación de `Alert`
pero con `role="status"` explícito, porque interrumpir un cálculo en curso es
sobre-anuncio. Hay precedentes en `inventory-client.tsx:479` y
`payroll-client.tsx:2042`.

---

## 2. Estructura de página — `PageContainer` / `PageHeader` **(nuevo)**

**El problema que cierra.** Hoy los 9 `app/*/page.tsx` repiten a mano el mismo
wrapper y el mismo `<h1>`:

```
mx-auto flex min-h-screen max-w-{3xl|4xl|5xl} flex-col gap-{4|6} px-6 py-12
```

Tres anchos distintos sin criterio (`admin` y `vales` en `4xl`; `cash`,
`invoices`, `payroll`, `alerts` y `services` en `5xl`), y el `<h1>` cambia de
`text-2xl` a `text-3xl` según la rama **dentro del mismo archivo**
(`admin/page.tsx:37` contra `:63`).

**La regla: el ancho lo decide el contenido, no la costumbre.**

| `size` | Ancho | Cuándo |
|---|---|---|
| `narrow` | `max-w-md` | Ingreso y mensajes de pantalla completa (sin sede, error, 404). |
| `default` | `max-w-4xl` | Contenido general: formularios, listados de tarjetas, el panel admin. |
| `wide` | `max-w-5xl` | Listados con tabla ancha. |

**Nunca escribas `min-h-screen` en el hijo del shell.** `app-shell.tsx` ya
declara `min-h-screen` en la raíz y su `lg:flex` estira al hijo; repetirlo es
redundante en escritorio y en móvil `100vh` incluye la barra del navegador, así
que aparece un scroll fantasma en páginas cortas. Si necesitás altura de
viewport, usá `dvh`, nunca `vh`.

```tsx
<PageContainer size="default">
  <PageHeader
    title="Administración"
    description="Empleados, impuestos y métodos de pago de su sede."
    actions={<button className={buttonClass}>Nuevo empleado</button>}
  />
  {/* … */}
</PageContainer>
```

El `<h1>` es siempre `text-3xl font-bold`. Una sola vez por página, en
`PageHeader`.

---

## 3. Pestañas — `Tabs` **(nuevo)**

**El problema que cierra.** `admin-tabs.tsx:57-65` declara `role="tablist"` y
`role="tab"` con `aria-selected`, pero no tiene `role="tabpanel"`, ni
`aria-controls`, ni `tabIndex` rotativo, ni navegación por flechas. El lector de
pantalla anuncia «pestaña» y el teclado no puede recorrerlas. Un `role="tab"` a
medias es peor que no tenerlo: promete un contrato que no cumple.

| Requisito | Por qué |
|---|---|
| `aria-controls` en cada pestaña | Apunta al `id` de su panel. |
| `role="tabpanel"` + `aria-labelledby` | El panel existe de verdad y se anuncia con su pestaña. |
| `tabIndex`: `0` en la activa, `-1` en el resto | Un solo punto de tabulación; el resto se recorre con flechas. |
| `←` `→` (horizontal), `Inicio`, `Fin` | Navegación estándar del patrón. |
| Activación al enfocar | Es un juego de pestañas de contenido, no un asistente. |

**Cuando NO usar pestañas:** si el usuario puede necesitar ver dos secciones a
la vez, o si son más de ~7, no es un `tablist` — es una barra lateral o un
submenú.

---

## 4. Diálogos — `FormDialog` / `ConfirmDialog` **(nuevo)**

**El problema que cierra.** `invoices-client.tsx` tiene 6 `DialogContent` y
**0** `DialogTitle`. Radix toma el nombre accesible del diálogo del título: sin
él, esos 6 modales se anuncian sin nombre. Hacerlo a mano es fácil de olvidar, y
por eso el olvido ya ocurrió 6 veces.

| Regla | Detalle |
|---|---|
| Todo `DialogContent` lleva `DialogTitle` | Sin excepción. Es lo que lo hace verificable (§10). |
| Un `ConfirmDialog` lleva además `DialogDescription` | El cuerpo explica qué se pierde, no solo «¿Seguro?». |
| `FormDialog` lleva el `Alert` de error adentro | El fallo al guardar es estado: no se va solo. |
| El botón de envío se bloquea y dice qué está haciendo | «Guardando…», no un `disabled` mudo. |
| Cancelar NO se bloquea mientras guarda | Atrapa al usuario en un guardado que se colgó. Si la respuesta llega después de cerrar, el `toast` de éxito la reporta igual. |
| Un destructivo no se confirma con un segundo clic en fila | Se confirma en `ConfirmDialog`, que es leíble y cancelable. |
| El botón destructivo repite el `hover` de fondo | `buttonClass` trae `hover:bg-primary-700` y `tailwind-merge` solo descarta lo que cae en el MISMO grupo, así que sin `hover:bg-error` el destructivo se pinta azul de marca. Ya resuelto dentro de `ConfirmDialog`; es la razón de que exista. |

El caso de la baja de una denominación (`cash-section.tsx:157`) es el ejemplo:
hoy es un clic directo sobre `Eliminar`, sin confirmación.

**Ancho del diálogo:** usá el tamaño que ya trae el primitivo. Un formulario de
2 columnas necesita `max-w-2xl`; no lo ajustes por archivo sin motivo.

---

## 5. Tablas — `DataTable` **(nuevo)**

**El problema que cierra.** 16 `overflow-x-auto` escritos a mano y 18
`min-w-[NNNpx]` sueltos, cada uno inventado en el lugar. Sin un primitivo, la
tabla 20 no se parece a la 1.

| Regla | Detalle |
|---|---|
| El scroll horizontal vive en el primitivo | `overflow-x-auto` + `w-full`, no en cada llamador. |
| El `min-width` sale de una escala | `sm` `md` `lg` `xl`. Los valores arbitrarios viven **solo** dentro de `DataTable`. |
| Encabezado y fila usan `tableHeaderClass` / `tableRowClass` | Ya existen en `ui-styles.ts`. |
| Columnas con dato largo: `truncate` + `title` | Ver `employees-section.tsx` como referencia. |
| En móvil, la tabla se desplaza | No se apilan columnas todavía: es deuda consciente (§9). |

---

## 6. Estados vacíos — `EmptyState` **(nuevo)**

Un listado vacío describe el **baseline esperado**, no bloquea nada y nunca
anunció nada. Envolverlo en `Alert` **agrega** un anuncio `aria-live` que antes
no existía: eso es un cambio de conducta, no una mejora.

| Regla | Detalle |
|---|---|
| `EmptyState` **no** lleva `role` ni `aria-live` | Su ausencia es la decisión. |
| Distinguí «todavía no hay nada» de «el filtro no encontró nada» | Ver `employees-section.tsx`: dos textos distintos para dos casos distintos. |
| Lo que sí bloquea va a `Alert` | «El usuario no tiene sede asignada» es estado bloqueante, y ese sí anuncia. |

---

## 7. Feedback — congelado

| Canal | Qué comunica | Persistencia |
|---|---|---|
| `toast` | Un evento que acaba de pasar | Efímera, se va solo |
| `Alert` | Lo que ES el caso hasta que algo cambie | Persistente |
| `EmptyState` | El baseline de una lista | Persistente, mudo |

El rol ARIA **no se elige por color, se elige por consecuencia**: asertivo solo
si el usuario tiene que actuar antes de seguir. `alert.tsx` ya expone la prop
`role` para el caso derivado en vivo (§1).

No se toca `alert.tsx` ni `sonner.tsx` sin motivo: tienen verificación propia.

---

## 8. Accesibilidad mínima obligatoria

Piso no negociable. Si algo de acá no se cumple, la pantalla no está terminada.

| Requisito | Criterio | Cómo se ve hoy |
|---|---|---|
| Todo `DialogContent` con `DialogTitle` | Nombre accesible | **Falla en 6 modales** de `invoices-client.tsx` |
| `tablist` completo (`tabpanel`, `aria-controls`, flechas) | Patrón APG | **Falla** en `admin-tabs.tsx` |
| Todo control con `focus-visible:ring-2` | WCAG 2.4.7 | Cumple: `buttonClass`/`ghostClass` lo traen |
| Todo `<input>` con `<label>` | WCAG 1.3.1 / 3.3.2 | Cumple en el 70% medido; el placeholder **no** es label |
| El estado no se comunica solo por color | WCAG 1.4.1 | Cumple: `Badge`/`Alert` llevan texto |
| Contraste texto ≥ 4.5:1, UI ≥ 3:1 | WCAG 1.4.3 / 1.4.11 | Cumple en los pares de tokens del sistema |
| Objetivo táctil ≥ 24×24 px | WCAG 2.5.8 (AA) | Cumple: `buttonClass` ≈ 36 px |
| Objetivo táctil ≥ 44×44 px en la acción primaria móvil | WCAG 2.5.5 (AAA) | **Pendiente**: las píldoras de pestaña miden ≈ 28 px |
| `prefers-reduced-motion` respetado | WCAG 2.3.3 | Cumple: bloque global en `globals.css` |

Elegimos el umbral de 24 px como piso duro (AA) y 44 px como objetivo de la
acción primaria en móvil. Las píldoras de navegación de `Tabs` se definen con
alto suficiente para superar los 44 px: son el caso que hoy no llega.

---

## 9. Estilos: el vocabulario canónico

La regla es una sola: **el color y la forma salen de `src/shared/lib/ui-styles.ts`
y de los tokens, nunca se reinventan en el archivo.**

| En vez de… | Usá | Veces que hoy se escribe a mano |
|---|---|---|
| `<h2 className="text-lg font-semibold">` | `sectionTitleClass` | 12 (contra 15 usos del canónico) |
| `rounded-md border border-border-color …` | `ghostClass` | 20 |
| `border border-border-color bg-surface p-4 shadow-sm` | `sectionClass` | — |
| `text-slate-500`, `bg-white`, `text-emerald-700` | tokens del proyecto | 0 fuera de la allowlist de facturación |
| `min-w-[960px]` | `DataTable` | 18 |
| `max-w-* mx-auto …` en el `<main>` | `PageContainer` | 18 |

**Prohibido explícitamente:** escribir una clase del proyecto sin capa que
colisione con una utilidad de Tailwind. `design-tokens.css` ya tuvo ese bug dos
veces (`.shadow-*` y `.bg-surface`); una regla sin capa gana en silencio a
`@layer utilities` y el valor deja de ser el que dice el token.

### Quién declara el VOCABULARIO y quién lo CONSUME

La distinción es entre el vocabulario de **color/superficie** y las constantes de
**control**, y no es la misma regla para los dos:

- **Color y superficie: el primitivo los declara adentro.** `alert.tsx`,
  `badge.tsx`, `dialog.tsx`, `empty-state.tsx` y `tabs.tsx` escriben
  `text-text-secondary`, `bg-surface`, `bg-surface-selected` en su propio
  archivo, porque un primitivo es justamente la DEFINICIÓN de qué significa
  "superficie de advertencia" o "segmento seleccionado". Si los tomaran de
  afuera, el primitivo dependería del archivo de su consumidor y la flecha se
  invertiría.
- **Controles: el primitivo los IMPORTA de `ui-styles.ts`.** `form-dialog.tsx`
  importa `buttonClass` y `ghostClass`. Duplicar el botón primario adentro del
  diálogo crearía una SEGUNDA definición del mismo botón — exactamente la
  duplicación que este proyecto ya eliminó una vez (8 copias de `formatMoney`, 2
  de `inputClass`). El botón no es vocabulario del diálogo: es una pieza
  compartida que el diálogo usa.

Criterio para decidir de qué lado cae algo nuevo: **si otro módulo ya lo
necesita con el mismo valor, vive en `ui-styles.ts` y el primitivo lo importa;
si es lo que el primitivo DEFINE, vive adentro.**

Por eso `EmptyState` usa `text-text-secondary` (color: lo define él) mientras
que `FormDialog` importa `buttonClass` (control: es de todos).

### Lo que NO se toca

- **La hoja de la factura.** La familia `--paper-*`, `bg-white` + `shadow-2xl` +
  `border-double` y su grilla son divergencia **licenciada**: un documento no se
  temiza, igual que el resultado de una impresora no cambia porque la pantalla
  esté en oscuro. No es deuda.
- **Los 40 tokens de cromo de `invoices-client.tsx`** que la allowlist de
  `no-raw-palette.test.ts` fija con conteo exacto: ninguno tiene un token del
  proyecto con el mismo valor en los dos temas.
- **`alert.tsx` y `sonner.tsx`:** verificados por su propio test.

---

## 10. Cómo se hace cumplir

Una regla sin guarda se erosiona. Cada sección de arriba tiene su test, con el
estilo de los que ya existen en `app/tests/` (control negativo, piso anti-vacío,
conteo de **tokens completos** y nunca substrings — este repo ya se quemó dos
veces con grep de substring: `text-text-primary` termina en `text-primary`, y
`border-border` matchea `border-border-color`).

| Guarda | Qué prohíbe |
|---|---|
| `no-raw-palette.test.ts` ✅ | Utilidades de la paleta cruda de Tailwind |
| `badge-adoption.test.ts` ✅ | Componer una pastilla a mano |
| `feedback-batch{2..6}.test.ts` ✅ | Roles ARIA ad-hoc por módulo |
| `ux-structure.test.ts` **(nuevo)** | El shell copiado en un `page.tsx`, y `min-h-screen` en un hijo del shell |
| `ux-dialog.test.ts` **(nuevo)** | Un `DialogContent` sin `DialogTitle` |
| `ux-tabs.test.ts` **(nuevo)** | `role="tablist"` sin `tabpanel` en el mismo archivo |
| `ux-empty-state.test.ts` **(nuevo)** | `EmptyState` sin `role` ni `aria-live`, con tokens del proyecto |
| `ux-adoption.test.ts` **(nuevo)** | Ningún `DialogContent` sin `DialogTitle` en el árbol (allowlist exacta); sin `role="tab*"` ni `min-w-[Npx]` a mano en admin |

Una guarda se prueba **por mutación**: se rompe el código a propósito y se
confirma que falla. Una guarda que no se probó por mutación no se sabe si mira.

---

## 11. Checklist de revisión

Antes de pedir revisión, confirmá cada punto. Si alguno no aplica, decilo.

- [ ] La superficie sale de la tabla de §1, y está justificada si es inline.
- [ ] La página usa `PageContainer` + `PageHeader`; no hay wrapper ni `<h1>` a mano.
- [ ] Ningún `min-h-screen` fuera del shell.
- [ ] Todo `DialogContent` tiene `DialogTitle`; los confirmatorios, `DialogDescription`.
- [ ] Las pestañas cumplen el patrón completo (§3).
- [ ] Éxito = toast, estado = `Alert`, vacío = `EmptyState`. Ningún hecho por dos canales.
- [ ] Todo control tiene `focus-visible:ring`. Todo `<input>`, su `<label>`.
- [ ] Cero clases de paleta cruda; uso de `ui-styles.ts` para lo que ya existe ahí.
- [ ] `npm run typecheck` · `npx eslint app src` · `npm test` en verde desde `app/`.
- [ ] El diff se puede revisar de una sentada. Si no, se partió mal.

---

## 12. Deuda conocida y fuera de alcance

Anotada acá para que no se pierda y para que nadie la «arregle» por sorpresa.

| Deuda | Dueño |
|---|---|
| El login (fallos confirmados, AUTH-01, pista en vivo) | ✅ WU-C, lote 5 |
| Los 6 modales de `invoices-client.tsx` sin `DialogTitle` | Tanda propia (F1 en `odd/tasks/ajustes-post-lote.md`) |
| Filtros de alertas sin UX real | Tanda propia (A1) |
| El listado de períodos de nómina no escala a un año | Tanda propia (N1) |
| Un vale sobre el tope no avisa antes de crearse | Tanda propia (V1) |
| El sistema de color (C1) sigue sin dirección decidida | **Bloqueado por decisión**: es ortogonal a la estructura, pero hay que cerrarlo antes de cualquier pasada visual fina |
| Las tablas no se apilan en móvil | Deuda consciente: se desplazan |
| 40 tokens de cromo en `invoices-client.tsx` | Divergencia licenciada (§9) |

---

## 13. Próximo paso

Refactorizar `/admin` como **implementación de referencia**: es el primer
consumidor de todo lo de arriba. Ver `odd/tasks/estandar-ux-ui.md`.
