'use client'

import * as React from 'react'
import { cn } from './utils'

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
 * Combobox con filtro por texto (escribir para filtrar).
 * Reemplaza a Select cuando el catálogo es grande (productos, servicios,
 * empleados). Solo abre el desplegable al hacer clic; clic afuera o
 * Escape lo cierra.
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
  const containerRef = React.useRef<HTMLDivElement>(null)

  function close() {
    setOpen(false)
    setFilter('')
  }

  // Cierra al hacer clic en cualquier otro lado (robusto ante z-index/portales).
  React.useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

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

      {open && (
          <div
            role="listbox"
            aria-label={ariaLabel}
            className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-border-color bg-surface shadow-xl dark:border-border-color-2 dark:bg-surface"
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
            <div className="max-h-[240px] overflow-y-auto p-1">
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
          </div>
      )}
    </div>
  )
}

export { Combobox }
export type { ComboboxOption, ComboboxProps }
