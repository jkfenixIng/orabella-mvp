'use client'

import * as React from 'react'
import { cn } from './utils'

/* Pestañas con el patrón APG completo.

   Por qué existe una primitiva y no un `role="tablist"` escrito a mano:
   `app/admin/admin-tabs.tsx` declaraba `role="tablist"` + `role="tab"` +
   `aria-selected` y nada más —sin `role="tabpanel"`, sin `aria-controls` y sin
   `tabIndex` rotativo—. Un rol a medias es PEOR que ninguno: el lector de
   pantalla anuncia «pestaña» y promete un contrato que nadie cumple (el panel
   existe, hay un solo punto de tabulación, las flechas recorren el juego). El
   vocabulario de roles es indivisible: o se emite completo o no se emite.

   La activación es automática: al enfocar se activa. Esto no es un asistente,
   es un juego de pestañas de contenido, donde mostrar el panel vecino es
   barato; la activación manual se reserva para flujos donde cambiar de paso
   cuesta datos.

   Todo lo que hace accesible a la primitiva se resuelve adentro: quien consume
   solo declara valor, etiqueta y contenido, así que no puede dejar el contrato
   a medias sin darse cuenta. */

/* ---------------------------------------------------------------------------
   Ids cruzados (exportados para el test de contrato).

   Cada pestaña y su panel se referencian mutuamente por id (`aria-controls` /
   `aria-labelledby`). Estas dos funciones son la ÚNICA fuente de esa relación:
   si el panel tuviera que deducir el id de su pestaña por su cuenta, el vínculo
   se rompería en silencio y el lector de pantalla leería «pestaña» sin panel.
   Se exportan para poder fijar el par en un test sin DOM, igual que
   `computeDialogZIndex` en dialog.tsx.
   --------------------------------------------------------------------------- */

/** Id del botón `role="tab"` que activa `value`. */
function tabTriggerId(baseId: string, value: string): string {
  return `${baseId}-tab-${value}`
}

/** Id del `role="tabpanel"` de `value`; es el destino de `aria-controls`. */
function tabPanelId(baseId: string, value: string): string {
  return `${baseId}-panel-${value}`
}

/* ---------------------------------------------------------------------------
   Navegación por teclado (exportada para el test de contrato).

   Devuelve el índice destino, o `null` cuando la tecla NO es de navegación.
   La distinción importa: el manejador corta el comportamiento por defecto solo
   con una tecla de navegación (las flechas y Inicio/Fin también scrollean la
   página), y `Tab` nunca se intercepta porque tiene que poder salir del juego.

   `current` es un índice válido del tablist (`0 <= current < count`); el
   manejador lo garantiza antes de llamar.
   --------------------------------------------------------------------------- */

/** Teclas que mueven el foco dentro de un `tablist` horizontal (patrón APG). */
function resolveTabNavigation(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
      // El juego envuelve: la última pestaña lleva a la primera.
      return (current + 1) % count
    case 'ArrowLeft':
      return (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/* ---------------------------------------------------------------------------
   Vocabulario visual: control segmentado, no una fila de píldoras.

   El track tiene borde y fondo propios (la ranura) y el segmento activo se
   apoya adentro. Todos los colores salen de tokens del proyecto
   (`src/styles/design-tokens.css` por el puente `@theme inline` de
   `globals.css`), así que el control se invierte solo en `.dark`: no necesita
   variantes `dark:` para el texto ni para el anillo de foco, y no puede
   arrastrar un color crudo.

   `bg-surface-selected` es el token que existe exactamente para este rol (el
   segmento elegido de un control segmentado, ver `theme-toggle.tsx`): su paso de
   luminancia contra la superficie de la página es el mismo en los dos temas, y
   `bg-surface-hover` no lo reemplaza —queda a 0.020 de la página en claro y el
   estado activo se vuelve indistinguible.

   `min-h-11` es el objetivo táctil de 44 px del estándar (§8 de
   `docs/ux-ui-standard.md`). Las píldoras que esta primitiva reemplaza medían
   ≈28 px: no llegaban ni al piso duro de 24 px. */
const TABS_ROOT_CLASS = 'flex flex-col'
const TABS_LIST_CLASS = 'inline-flex flex-wrap items-center gap-1 rounded-lg border border-border-color bg-surface p-1 dark:border-border-color-2'
const TABS_TRIGGER_CLASS = 'inline-flex min-h-11 items-center justify-center whitespace-nowrap rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
const TABS_TRIGGER_ACTIVE_CLASS = 'bg-surface-selected text-text-primary font-medium shadow-sm'
const TABS_TRIGGER_INACTIVE_CLASS = 'text-text-secondary hover:bg-surface-hover'

type TabsContextValue = {
  /** Valor de la pestaña activa; lo posee quien consume. */
  value: string
  /** Base de ids generada por la raíz: de acá salen los pares tab/panel. */
  baseId: string
  /** Nombre accesible del `tablist` (`aria-label`). */
  label: string
  onValueChange: (value: string) => void
}

const TabsContext = React.createContext<TabsContextValue | null>(null)

/**
 * Contexto del juego. Falla ruidosamente si un hijo se usa fuera de `Tabs`: sin
 * contexto no hay ids cruzados posibles, y un `role="tab"` suelto volvería a
 * prometer el contrato a medias que esta primitiva existe para cerrar.
 */
function useTabsContext(component: string): TabsContextValue {
  const context = React.useContext(TabsContext)
  if (context === null) {
    throw new Error(`${component} debe renderizarse dentro de <Tabs>`)
  }
  return context
}

type TabsProps = {
  value: string
  onValueChange: (value: string) => void
  /** Nombre accesible del `tablist`; no es decorativo, es lo que anuncia el lector. */
  label: string
  className?: string
  children: React.ReactNode
}

/**
 * Raíz controlada. Genera la base de ids con `useId` (estable entre servidor y
 * cliente) y publica el valor activo por contexto: los triggers y los paneles no
 * se pasan props de a pares, así que `aria-controls` y `aria-labelledby` no
 * pueden quedar desincronizados por descuido de quien consume.
 */
const Tabs = ({ value, onValueChange, label, className, children }: TabsProps) => {
  const generatedId = React.useId()
  // `useId` garantiza unicidad y estabilidad entre servidor y cliente, no un
  // formato: se normaliza UNA vez acá. Los `aria-*` solo exigen que los dos
  // lados usen la misma cadena, y de paso el id queda seguro como selector CSS.
  const baseId = `tabs-${generatedId.replace(/[^a-zA-Z0-9_-]/g, '')}`

  // El objeto se memoiza para que un re-render de quien consume por un motivo
  // ajeno a las pestañas no invalide el contexto de todos los triggers.
  const context = React.useMemo<TabsContextValue>(
    () => ({ value, baseId, label, onValueChange }),
    [value, baseId, label, onValueChange],
  )

  return (
    <TabsContext.Provider value={context}>
      <div className={cn(TABS_ROOT_CLASS, className)}>{children}</div>
    </TabsContext.Provider>
  )
}

type TabsListProps = {
  className?: string
  children: React.ReactNode
}

/**
 * El `tablist`. Es el dueño de la navegación: las teclas se manejan en el
 * contenedor porque el foco se mueve entre hermanos, y el orden de tabulación es
 * el orden del DOM (los valores no se duplican en un estado paralelo que podría
 * desincronizarse con pestañas condicionales).
 */
const TabsList = ({ className, children }: TabsListProps) => {
  const { label } = useTabsContext('TabsList')

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const triggers = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    )
    const selectedIndex = triggers.findIndex(
      (trigger) => trigger.getAttribute('aria-selected') === 'true',
    )
    // Un `value` que no corresponde a ninguna pestaña no puede dejar la
    // navegación sin punto de partida: se arranca desde la primera.
    const next = resolveTabNavigation(
      event.key,
      selectedIndex >= 0 ? selectedIndex : 0,
      triggers.length,
    )
    if (next === null) return
    event.preventDefault()
    const target = triggers.at(next)
    if (target === undefined) return
    target.focus()
    // Se activa por el MISMO camino que el puntero —el `click` del botón
    // destino— en vez de escribir el valor a mano: así la activación por
    // teclado y la activación por clic no pueden divergir nunca.
    target.click()
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={handleKeyDown}
      className={cn(TABS_LIST_CLASS, className)}
    >
      {children}
    </div>
  )
}

type TabsTriggerProps = {
  value: string
  className?: string
  children: React.ReactNode
}

/**
 * Un segmento. Declara el lado «pestaña» del contrato: `aria-selected` dice si
 * está activo y `aria-controls` apunta al id de su panel, que es quien va a
 * declarar `aria-labelledby` de vuelta.
 */
const TabsTrigger = ({ value, className, children }: TabsTriggerProps) => {
  const { value: activeValue, baseId, onValueChange } = useTabsContext('TabsTrigger')
  const isActive = activeValue === value

  return (
    <button
      type="button"
      role="tab"
      id={tabTriggerId(baseId, value)}
      aria-selected={isActive}
      aria-controls={tabPanelId(baseId, value)}
      // tabIndex rotativo: el juego entero es UN punto de tabulación y el resto
      // se recorre con flechas. Sin esto, el teclado atraviesa las seis
      // pestañas de administración antes de llegar al contenido.
      tabIndex={isActive ? 0 : -1}
      onClick={() => onValueChange(value)}
      className={cn(
        TABS_TRIGGER_CLASS,
        isActive ? TABS_TRIGGER_ACTIVE_CLASS : TABS_TRIGGER_INACTIVE_CLASS,
        className,
      )}
    >
      {children}
    </button>
  )
}

type TabsPanelProps = {
  value: string
  className?: string
  children: React.ReactNode
}

/**
 * El panel. Sin él, `role="tab"` no tiene destino: es la mitad que faltaba.
 *
 * El panel inactivo no se renderiza (no un `hidden`): el contenido oculto igual
 * se monta, corre efectos y dispara sus consultas. Desmontarlo es lo que ya hace
 * `admin-tabs.tsx` con su ternario, así que migrar no cambia el costo en datos.
 */
const TabsPanel = ({ value, className, children }: TabsPanelProps) => {
  const { value: activeValue, baseId } = useTabsContext('TabsPanel')
  if (activeValue !== value) return null

  return (
    <div
      role="tabpanel"
      id={tabPanelId(baseId, value)}
      aria-labelledby={tabTriggerId(baseId, value)}
      className={className}
    >
      {children}
    </div>
  )
}

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsPanel,
  resolveTabNavigation,
  tabPanelId,
  tabTriggerId,
  type TabsProps,
  type TabsListProps,
  type TabsTriggerProps,
  type TabsPanelProps,
}
