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
          'flex h-10 w-full items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-slate-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600',
          selectedOption ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400',
        )}
      >
        <span className="truncate">{selectedOption ? selectedOption.label : placeholder}</span>
        <svg
          className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200', open && 'rotate-180')}
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
            className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border border-slate-300 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
          >
            <div className="border-b border-slate-200 p-2 dark:border-slate-700">
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
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
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
                      ? 'bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100'
                      : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                  )}
                >
                  {clearLabel}
                </button>
              )}
              {filteredOptions.length === 0 ? (
                <p className="px-3 py-4 text-center text-sm text-slate-500">{noResultsText}</p>
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
                        ? 'bg-emerald-50 font-medium text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : 'text-slate-900 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.description ? (
                      <span className="shrink-0 text-xs text-slate-500">{option.description}</span>
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
