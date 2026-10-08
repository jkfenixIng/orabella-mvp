import * as React from 'react'

import { cn } from './utils'

/* --------------------------------------------------------------------------
   DataTable — la tabla de datos y, sobre todo, su CARRIL DE SCROLL.

   El defecto que cierra: hoy cada llamador escribe a mano el mismo envoltorio
   (`<div className="overflow-x-auto">`), la misma `<table className="min-w-full
   text-left text-sm">` y, cuando la tabla no entra, su propio piso de ancho
   inventado (`min-w-[420px]`, `[880px]`, `[1040px]`...). Son 16 envoltorios y 18
   pisos distintos en el árbol: la tabla 20 no se parece a la tabla 1.

   LA DECISIÓN DE ESTE PRIMITIVO ES DÓNDE VIVE LA ESCALA. Un `min-w` arbitrario
   tiene UN solo hogar —`MIN_WIDTH`, acá abajo— y sus cinco anchos son
   EXACTAMENTE los valores que el árbol ya renderiza, elegidos para que migrar un
   llamador no mueva un píxel. Un `min-w-[Npx]` nuevo en un feature es deuda
   nueva: la guarda `tests/ux-data-table.test.ts` lo rechaza.

   Lo que NO decide: el espaciado vertical del envoltorio ni la alineación fina
   de cada tabla. Eso es del llamador y entra por `wrapperClassName` y
   `className`. Y no decide el vocabulario de celdas: `<tr>`/`<td>` siguen
   usando `tableHeaderClass` / `tableRowClass` / `tableCellClass` de
   `src/shared/lib/ui-styles.ts`. Este primitivo aporta el carril y la escala,
   no reemplaza ese vocabulario.

   Sin `'use client'`: no usa hooks, estado ni handlers, así que el mismo archivo
   sirve desde un Server Component y desde un Client Component —igual que
   `alert.tsx` y `empty-state.tsx`.
   -------------------------------------------------------------------------- */

/**
 * La escala de ancho mínimo. Es el ÚNICO lugar de producción donde vive un
 * `min-w-[Npx]`; los valores no se eligieron acá, son los que ya estaban en uso.
 *
 * `none` no es un ancho: es el permiso explícito de no fijar piso cuando la
 * tabla ya fluida alcanza (`min-w-full`), y existe para que ese caso también
 * pase por el vocabulario en vez de por una clase suelta y distinta por archivo.
 */
const MIN_WIDTH = {
  none: '',
  sm: 'min-w-[420px]', // tabla de detalle chica
  md: 'min-w-[560px]',
  lg: 'min-w-[880px]', // el default
  xl: 'min-w-[960px]',
  '2xl': 'min-w-[1040px]',
} as const

export type DataTableMinWidth = keyof typeof MIN_WIDTH

export interface DataTableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /**
   * Paso de la escala. Default `lg`. El llamador elige un nombre, nunca un
   * número: un ancho nuevo se decide acá, una sola vez para toda la app.
   */
  minWidth?: DataTableMinWidth
  /**
   * Clases del envoltorio con scroll. Es donde va el espaciado del llamador
   * (por ejemplo `mt-3`), porque el `margin` no pertenece a la tabla.
   */
  wrapperClassName?: string
}

export function DataTable({
  minWidth = 'lg',
  className,
  wrapperClassName,
  children,
  ...props
}: DataTableProps) {
  return (
    <div className={cn('overflow-x-auto', wrapperClassName)}>
      <table className={cn('w-full text-left text-sm', MIN_WIDTH[minWidth], className)} {...props}>
        {children}
      </table>
    </div>
  )
}
