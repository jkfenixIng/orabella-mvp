# Estándar UX/UI y administración como implementación de referencia

## Objective
Dejar un estándar de desarrollo UX/UI **ejecutable** (no un documento de buenas
intenciones) y probarlo refactorizando `/admin` como su primer consumidor: la
jerarquía de página, el sub-menú de administración, las superficies de
crear/editar y la accesibilidad dejan de resolverse a mano en cada archivo.

## Problem (medido sobre el árbol, HEAD `d072684`)

El color, los tokens, la disciplina de paleta, `Badge` y el criterio
estado-vs-evento (`Alert`/toast) **ya están hechos y con guardas por test**. Lo
que queda abierto no es esa capa: es la de **estructura y superficies**, que
nadie tiene anotada.

1. **El shell de página está copiado a mano 9 veces.** Cada `app/*/page.tsx`
   repite `<main className="mx-auto flex min-h-screen max-w-{3xl|4xl|5xl}
   flex-col gap-{4|6} px-6 py-12">` y su `<h1 className="text-{2xl|3xl}
   font-bold">`. Tres anchos sin criterio (`admin` y `vales` en `4xl`; `cash`,
   `invoices`, `payroll`, `alerts`, `services` en `5xl`) y el `<h1>` cambia de
   `text-2xl` a `text-3xl` según la rama dentro del MISMO archivo. No existe
   `PageHeader` ni `PageContainer`.
2. **`min-h-screen` dentro del layout de shell.** `app-shell.tsx` arma
   `lg:flex` con un `aside` de `h-screen`, y cada `<main>` vuelve a pedir
   `min-h-screen`: altura de viewport duplicada en escritorio.
3. **El sub-menú de administración no es un tab válido.**
   `app/admin/admin-tabs.tsx:57-65` declara `role="tablist"` + `role="tab"` +
   `aria-selected`, pero **sin** `role="tabpanel"`, sin `aria-controls`, sin
   `tabIndex` rotativo y sin navegación por flechas. Un lector de pantalla
   anuncia "pestaña" y el teclado no puede recorrerlas. Visualmente es una fila
   de píldoras (`px-3 py-1 text-sm`) sin jerarquía, en un ancho (`max-w-4xl`)
   que no le queda cómodo a 6 pestañas con tablas anchas.
4. **El mismo tipo de acción se resuelve de dos maneras en el mismo panel.**
   Con diálogo: Empleados (`employees-section.tsx`), Roles (`users-section.tsx`),
   Vales (`vales-section.tsx`). Con formulario inline pegado a la lista:
   Impuestos (`taxes-section.tsx:85`), Métodos (`methods-section.tsx:90`),
   Caja (`cash-section.tsx:146`). No hay una regla de superficie.
5. **6 diálogos sin nombre accesible.** `app/invoices/invoices-client.tsx`:
   medido `DialogContent=6`, `DialogTitle=0`. Radix exige el título para el
   nombre accesible del diálogo. Es el único archivo con esa deuda.
6. **La deriva de estilos vive donde la guarda no mira:** 12
   `<h2 className="text-lg font-semibold">` escritos a mano contra 15 usos de
   `sectionTitleClass` (mismo valor, dos caminos); 20 clases de botón fantasma
   crudas que deberían pasar por `ghostClass`; 18 `min-w-[NNNpx]` sueltos porque
   no hay primitivo de tabla; 16 `overflow-x-auto` a mano.

## Why
El usuario pidió revisar la UX del proyecto, arrancar por administración ("el
sub-menú es feo", "hay cosas que deberían manejarse con modales o dialogs") y
crear un estándar de desarrollo UX/UI. La capa de color y feedback ya está
resuelta y guardada; lo que falta es la de estructura, y es la que hoy obliga a
cada módulo a reinventar la jerarquía de página y la superficie de cada acción.
Un estándar sin guardas se erosiona: en este repo la consistencia se sostiene
con un test que falla, no con buena voluntad (`estilos-sistema.md`).

## Decisiones tomadas por el usuario (2026-10-02)
- **Alcance: estándar + primitivos primero, y `admin` como implementación de
  referencia.** Los pendientes UI de otros módulos (F1 modales de facturación,
  A1 filtros de alertas, N1 períodos de nómina, V1 aviso de tope de vale) quedan
  en tandas posteriores, ya anotados en `ajustes-post-lote.md`.
- **El sistema de color (C1) NO entra en esta tanda.** Sigue abierto y
  bloqueado desde el 2026-09-25; es ortogonal a la estructura. Se decide antes
  de cualquier pasada visual fina, no después.

## Corrección de estado: los documentos estaban atrasados
Antes de planificar se verificó contra el código, no contra la prosa:
- `estilos-sistema.md` da **WU5 pendiente** → **hecho**: `tests/no-raw-palette.test.ts:180-192`
  declara "WU5 hizo el resto... quedan 40" y la allowlist tiene el conteo exacto.
- `ux-feedback.md` da **WU-C pendiente** → **hecho en 6 lotes**:
  `tests/feedback-batch2..6.test.ts` cubren alertas, vales, nómina, inventario,
  panel admin, facturación, login y caja. Siguen abiertos solo WU-D (tinte por
  tipo del toast) y WU-E (corregir el criterio en el comentario de `alertRole()`),
  ambos de bajo impacto.

## Scope
### Dentro
- `app/docs/ux-ui-standard.md` (nuevo): el estándar, con la tabla de decisión de
  superficie, la accesibilidad mínima obligatoria y la lista de lo que NO se toca.
- Primitivos nuevos en `app/src/components/ui/lib/`: `page.tsx`
  (`PageContainer`/`PageHeader`), `tabs.tsx`, `form-dialog.tsx`
  (`FormDialog`/`ConfirmDialog`), `empty-state.tsx`, `data-table.tsx`.
- `app/app/admin/admin-tabs.tsx` y `app/app/admin/admin-sections/*`: consumidores.
- `app/app/*/page.tsx`: migración de los 9 shells al primitivo.
- `app/tests/`: guardas nuevas, al estilo de las que ya existen.

### Fuera (con motivo)
- La paleta y los tokens (`design-tokens.css`, `globals.css`): ya resueltos y
  guardados; C1 está bloqueado por decisión pendiente.
- La hoja de factura de `invoices-client.tsx` y su grilla: divergencia
  licenciada, ya congelada en la familia `--paper-*`.
- Los pendientes de otros módulos (F1, A1, N1, V1): tandas posteriores.
- `alert.tsx` y `sonner.tsx`: tienen verificación propia; no se tocan.

## Constraints
- No romper el arqueo (declarado vs cobrado) ni ningún contrato con el backend:
  esta unidad es de presentación.
- Las guardas nuevas se prueban por mutación, como las existentes.
- Toda migración de shell o superficie preserva textos, roles ARIA y los
  `role="status"`/`role="alert"` que los specs e2e afirman (9 specs, sobre todo
  `cash.spec.ts`, que tiene 5 aserciones sobre `p[role="status"]`).
- Commits por unidad de trabajo en `feat/orabella-mvp`, Conventional Commits en
  español (convención del repo), sin push ni PR sin decisión del usuario.
- Gate por unidad desde `app/`: `npm run typecheck` · `npx eslint app src` ·
  `npm test`. `next build` al cierre.

## Tasks
- [x] **WU1** Estándar `app/docs/ux-ui-standard.md` + primitivo `EmptyState`.
  Sin migrar: `tests/feedback-batch4.test.ts:461-472` pinea los 7 vacíos del
  panel admin como texto plano, así que la adopción va en WU6 con esa guarda
  actualizada a propósito. Mismo criterio que el WU-A de `Alert` en
  `ux-feedback.md`: existe el componente y su test, cero migración.
- [x] **WU2** `PageContainer`/`PageHeader` + los 10 `page.tsx` migrados +
  `tests/ux-structure.test.ts` (probado por mutación por el writer).
- [x] **WU3a** `Tabs` accesible: `role="tabpanel"`, `aria-controls`,
  `tabIndex` rotativo, flechas, `Inicio`/`Fin`, objetivo táctil de 44 px +
  `tests/ux-tabs.test.ts`. Primitivo sin migrar (la migración es WU6).
- [x] **WU4a** `FormDialog` + `ConfirmDialog` + `tests/ux-dialog.test.ts`.
  Primitivo sin migrar. Incluye `dialogsWithoutTitle()`, el predicado por bloque
  con control negativo que WU6 apunta al árbol entero.
- [x] **WU5a** `DataTable` + `tests/ux-data-table.test.ts` (render real con
  `react-dom/server`). Primitivo sin migrar. Deuda medida: **18** valores
  `min-w-[Npx]` inventados, en allowlist con conteo exacto por archivo.
- [ ] **WU6** Refactor de `/admin` como implementación de referencia: `Tabs` en
  `admin-tabs.tsx`, las tres secciones inline (Impuestos, Métodos, Caja) →
  `FormDialog`, confirmación en la baja de denominaciones, ancho de página,
  `EmptyState` en los 7 vacíos, `DataTable` en las tablas, y
  `tests/ux-adoption.test.ts`.
- [ ] **WU7** Cierre: gate completo, actualización de `odd/tasks/` y README del
  módulo admin.

## Acceptance
- Existe un `app/docs/ux-ui-standard.md` que decide casos, no que enuncia deseos.
- Ningún `page.tsx` repite el wrapper del shell ni el `<h1>` a mano.
- El sub-menú de administración se recorre con teclado y cada pestaña tiene su
  `tabpanel`.
- Crear/editar en el panel de administración pasa por una sola superficie.
- Ningún `DialogContent` sin `DialogTitle`.
- Guardas nuevas con control negativo y probadas por mutación.
- Gate: `typecheck` 0, `eslint` 0, `npm test` sin regresiones, `next build` OK.

## Progress
- 2026-10-02: doc creado. Alcance elegido por el usuario: estándar + primitivos,
  admin como referencia.
- 2026-10-02: WU1-WU5a aterrizados en paralelo sobre superficies disjuntas
  (4 writers). Gate completo del padre, en serie: `typecheck` 0 · `eslint` 0
  errores (1 warning preexistente en `app/error.tsx`) · **32 archivos / 1411
  tests** · `next build` ✓ 22/22.
  El relevamiento exhaustivo se colgó por timeout y **no se reemplazó**: la
  evidencia de las 6 falencias es la que midió el padre sobre el árbol.
- 2026-10-01: WU6c terminado: primer consumidor de `DataTable` (empleados y
  usuarios), diálogo muerto "Nuevo usuario" eliminado (el alta vive con el
  empleado), `tests/feedback-batch4.test.ts` re-based con verificación por
  mutación.
- 2026-10-01: WU6d (esta unidad) terminado: `tests/ux-empty-state.test.ts`
  (contrato del `EmptyState` mudo) + `tests/ux-adoption.test.ts` (adopción en
  todo el árbol, con allowlist exacta de los 6 diálogos de facturación bajo
  F1) y reconciliación de docs. WU7 (gate final en serie + cierre, dueño: el
  parent) queda abierto.

### Hallazgos que corrigieron al padre (no al revés)
1. **El warning de Radix no existe en esta versión.** Instruí verificar el aviso
   «Missing `Description`» de `@radix-ui/react-dialog`; el writer leyó el `dist/`
   instalado y encontró **cero** llamadas a `console.*` en `1.1.23`. No escribió
   el comentario que afirmaba silenciarlo: dejó dicho que hoy no avisa y que la
   prop se conserva como contrato a futuro. La premisa del padre era falsa.
2. **`min-w-[Npx]`: la aserción del padre era imposible.** Pedí "los cinco
   valores aparecen exactamente una vez en todo `app/src`", incompatible con la
   deuda preexistente. Además el walk correcto es la raíz de la app, no `src/`:
   **la deuda vive en `app/<módulo>/`**. El writer desvió documentando el motivo.
3. **El botón destructivo se pintaba azul de marca.** `buttonClass` trae
   `hover:bg-primary-700` y `tailwind-merge` solo descarta lo que cae en el mismo
   grupo: `hover:opacity-90` no lo alcanza. Defecto que el padre no había
   previsto; verificado con el `tailwind-merge` realmente instalado.
4. **§9 del estándar se contradecía con el código.** Decía que los primitivos no
   dependen de `ui-styles.ts`, pero `form-dialog.tsx` importa `buttonClass`.
   Corregido: el primitivo declara el vocabulario de **color** y **importa** las
   constantes de **control**, para no crear una segunda definición del botón.

### Decisiones de diseño que WU4a dejó abiertas y el padre cierra
- **Cancelar no se bloquea mientras guarda.** Atrapa al usuario en un guardado
  colgado; si la respuesta llega después, el toast la reporta igual. Pineado en
  el estándar §4.
- **`ConfirmDialog` sin `cancelLabel`.** Aceptado: la app es monolingüe y
  «Cancelar» no es una etiqueta que varíe por caso. Se agrega si alguna vez hace
  falta.
- **`TABS_ROOT_CLASS` sin `gap` y trigger con `px-3`.** Cosmético; WU6 pasa el
  espaciado con `className`. El objetivo táctil de 44 px sí se cumple con
  `min-h-11`.

## Route declaration
- Parent inline para el estándar (documento de arquitectura, no requiere writer).
- Delegación a `gentle-ai-worker` por WU con superficie de edición acotada; WUs
  que comparten archivo van EN SERIE. Verificación de gate por el parent, o
  `gentle-ai-verify` cuando la unidad toque contratos con el backend (no es el
  caso previsto: unidad de presentación).
