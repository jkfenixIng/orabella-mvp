'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from './utils'
import { usePopoverLayer } from './dialog'

interface ComboboxOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

interface ComboboxProps {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  options: ComboboxOption[]
  disabled?: boolean
  className?: string
  ariaLabel?: string
  filterPlaceholder?: string
  noResultsText?: string
  /** Muestra una primera fila para volver al valor vacío (filtros). */
  allowClear?: boolean
  clearLabel?: string
}

/**
 * R37 (medido en Chromium, 320x568, dentro del diálogo de emisión): la lista
 * se salía 98 px por debajo de la caja del diálogo que la recorta, no volteaba
 * nunca (`flippedUp=false`) y las opciones de abajo sólo se alcanzaban
 * scrolleando el DIÁLOGO. La causa era una sola: la lista iba `absolute`
 * DENTRO del diálogo, con `max-h-[240px]` fijo, sin portal y sin mirar la
 * colisión. Un `absolute` dentro de una caja con `overflow` no puede escapar de
 * ella: subir el `z-index` no ayuda, lo que lo recorta es el ancestro con scroll.
 *
 * El mecanismo NO es nuevo: es el del `Select` hermano (`select.tsx`), que ya
 * portalea a `document.body` y toma el apilamiento de `usePopoverLayer()`. Lo
 * que faltaba era la COLISIÓN, y esa sí es una cuenta: cuánto hay abajo, cuánto
 * arriba, y por lo tanto si la lista voltea y con qué alto.
 */

/** Tope de alto de la lista: la densidad de siempre, pero como techo y no como alto. */
const LIST_MAX_HEIGHT = 240
/** Aire entre el disparador y la lista. */
const LIST_GAP = 4

export interface ComboboxPlacement {
  /** `top` en coordenadas de viewport (la lista es `fixed`). */
  top: number
  left: number
  width: number
  /** Alto disponible del lado elegido, con el tope de siempre. Nunca negativo. */
  maxHeight: number
  flippedUp: boolean
}

/**
 * Dónde caerse la lista. Función pura a propósito: la cuenta de arriba/abajo es
 * lo que se puede afirmar sin navegador, y separarla del componente es lo que
 * permite que la guarda la ejecute con el caso medido a 320.
 *
 * La regla es una sola: se abre hacia abajo si abajo hay lugar para la lista
 * completa (`LIST_MAX_HEIGHT`); si no, y arriba hay MÁS lugar que abajo, se da
 * vuelta. Voltear siempre sería tan defectuoso como no voltear nunca, así que
 * las dos direcciones se afirman por separado.
 */
export function computeComboboxPlacement({
  trigger,
  viewport,
  gap = LIST_GAP,
  maxHeight = LIST_MAX_HEIGHT,
}: {
  trigger: { top: number; left: number; width: number; height: number }
  viewport: { width: number; height: number }
  gap?: number
  maxHeight?: number
}): ComboboxPlacement {
  const espacioAbajo = viewport.height - (trigger.top + trigger.height) - gap
  const espacioArriba = trigger.top - gap
  const flippedUp = espacioAbajo < maxHeight && espacioArriba > espacioAbajo
  const disponible = Math.max(0, flippedUp ? espacioArriba : espacioAbajo)
  const alto = Math.min(maxHeight, disponible)
  const left = Math.max(0, Math.min(trigger.left, viewport.width - trigger.width))
  return {
    top: flippedUp
      ? trigger.top - gap - alto
      : trigger.top + trigger.height + gap,
    left,
    width: trigger.width,
    maxHeight: alto,
    flippedUp,
  }
}

/**
 * Combobox con filtro por texto (escribir para filtrar).
 * Reemplaza a Select cuando el catálogo es grande (productos, servicios,
 * empleados). Solo abre el desplegable al hacer clic; clic afuera o
 * Escape lo cierra.
 *
 * R37: la lista se monta en un PORTAL y se coloca con
 * `computeComboboxPlacement` (ver la nota de R37 arriba), igual que hace el
 * `Select`. Por eso vive fuera del contenedor del disparador, y por eso el
 * clic-afuera tiene que mirar los dos nodos: si mirara sólo el contenedor,
 * elegir una opción cerraría la lista en el `pointerdown` — antes del `click` —
 * y no seleccionaría nada.
 */
function Combobox({
  value,
  onValueChange,
  placeholder = 'Seleccione...',
  options = [],
  disabled = false,
  className,
  ariaLabel,
  filterPlaceholder = 'Buscar...',
  noResultsText = 'No se encontraron resultados',
  allowClear = false,
  clearLabel = 'Todos',
}: ComboboxProps) {
  const [filter, setFilter] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [placement, setPlacement] = React.useState<ComboboxPlacement | null>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  // Mismo apilamiento del diálogo que usa el `Select`: un `z-50` fijo queda
  // debajo del contenido de un diálogo apilado.
  const popoverZ = usePopoverLayer()

  function close() {
    setOpen(false)
    setFilter('')
  }

  // Cierra al hacer clic en cualquier otro lado (robusto ante z-index/portales).
  React.useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      const dentroDelDisparador =
        containerRef.current !== null && containerRef.current.contains(target)
      const dentroDeLaLista = listRef.current !== null && listRef.current.contains(target)
      if (!dentroDelDisparador && !dentroDeLaLista) close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // La lista es `fixed` con coordenadas de viewport: si se midiera una sola vez
  // se quedaría clavada en el sitio viejo en cuanto scrollea el diálogo. Se
  // recalcula al abrir y en cada scroll/resize mientras esté abierta.
  const measure = React.useCallback(() => {
    const trigger = triggerRef.current
    if (trigger === null) return
    const rect = trigger.getBoundingClientRect()
    setPlacement(
      computeComboboxPlacement({
        trigger: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    )
  }, [])

  React.useEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    measure()
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [open, measure])

  const filteredOptions = React.useMemo(() => {
    const query = filter.trim().toLowerCase()
    if (query === '') return options
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        opt.description?.toLowerCase().includes(query) ||
        opt.value.toLowerCase().includes(query),
    )
  }, [options, filter])

  const selectedOption = options.find((opt) => opt.value === value)

  function choose(next: string) {
    onValueChange(next)
    close()
  }

  return (
    <div ref={containerRef} className={cn('relative w-full', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (disabled) return
          if (open) close()
          else setOpen(true)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={cn(
          'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-border-color bg-surface px-3 text-sm outline-none transition-colors placeholder:text-text-tertiary hover:border-border-color-2 focus:border-primary-600 focus:ring-2 focus:ring-primary-600/20 disabled:cursor-not-allowed disabled:opacity-50 dark:border-border-color-2 dark:bg-surface',
          selectedOption ? 'text-text-primary' : 'text-text-tertiary',
        )}
      >
        <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
        <svg
          className={cn('h-4 w-4 shrink-0 text-text-secondary transition-transform duration-200', open && 'rotate-180')}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* R37: la lista se monta en el `body` (igual que el `Select`) y se
          posiciona con la cuenta de `computeComboboxPlacement`. `placement` es
          `null` hasta el primer `measure`, y en ese frame no se pinta lista:
          una lista en (0,0) por un frame es peor que una lista un frame tarde. */}
      {open &&
        placement !== null &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              top: placement.top,
              left: placement.left,
              width: placement.width,
              maxHeight: placement.maxHeight,
              zIndex: popoverZ,
              // MEDIDO: sin esto la lista queda INCLICABLE dentro de un
              // diálogo. Al abrir un diálogo, Radix le pone
              // `pointer-events: none` al `body` para bloquear el scroll de
              // fondo, y como la lista ahora es hija directa del `body`
              // hereda ese `none` (el `DialogContent` se lo revierte en su
              // propia clase, y por eso el `absolute` de antes no lo sufría).
              // Es el mismo `pointerEvents: 'auto'` que pone el `Content` del
              // `Select` de Radix, por el mismo motivo.
              pointerEvents: 'auto',
            }}
            className="fixed flex flex-col overflow-hidden rounded-md border border-border-color bg-surface shadow-xl dark:border-border-color-2 dark:bg-surface"
          >
            <div className="border-b border-border-color-2 p-2">
              <input
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') close()
                }}
                placeholder={filterPlaceholder}
                autoFocus
                aria-label={filterPlaceholder}
                className="h-9 w-full rounded-md border border-border-color bg-surface px-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-primary-600 focus:ring-2 focus:ring-primary-600/20 dark:border-border-color-2 dark:bg-surface"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {allowClear && filter.trim() === '' && (
                <button
                  type="button"
                  role="option"
                  aria-selected={value === ''}
                  onClick={() => choose('')}
                  className={cn(
                    'flex w-full items-center rounded-md px-3 py-2 text-left text-sm transition-colors',
                    value === ''
                      ? 'bg-surface-hover font-medium text-text-primary'
                      : 'text-text-primary hover:bg-surface-hover',
                  )}
                >
                  {clearLabel}
                </button>
              )}
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-text-secondary">{noResultsText}</p>
              ) : (
                filteredOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onClick={() => {
                      if (!option.disabled) choose(option.value)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                      option.value === value
                        ? 'bg-success-light font-medium text-success'
                        : 'text-text-primary hover:bg-surface-hover',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.description ? (
                      <span className="shrink-0 text-xs text-text-secondary">{option.description}</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

export { Combobox }
export type { ComboboxOption, ComboboxProps }
