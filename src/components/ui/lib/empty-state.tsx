import * as React from 'react'

import { cn } from './utils'

/* --------------------------------------------------------------------------
   EmptyState — el estado base de una lista o tabla: "Aún no hay empleados en
   esta sede.", "Sin resultados para ese filtro.".

   LA DECISIÓN DE ESTE PRIMITIVO ES LO QUE **NO** HACE: no lleva `role` ni
   `aria-live`. Un listado vacío describe el baseline esperado, no bloquea nada
   y nunca se anunció. Envolverlo en `Alert` no sería "más consistente": sería
   AGREGAR un anuncio que hoy no existe, o sea un cambio de conducta disfrazado
   de refactor. El vacío es mudo a propósito.

   Lo que SÍ bloquea —"El usuario no tiene sede asignada.", el fallo al
   guardar— es un `Alert`, y ese sí anuncia (deriva el rol de su variante).

   Sin `'use client'`: no usa hooks, estado ni handlers, así que el mismo
   archivo sirve desde un Server Component y desde un Client Component.

   Nota de vocabulario: este primitivo declara los tokens del proyecto
   (`text-text-secondary`) en vez de importar `mutedTextClass` de
   `src/shared/lib/ui-styles.ts`. Es la misma convención que sus hermanos
   `alert.tsx`, `badge.tsx` y `dialog.tsx`: los primitivos DEFINEN el
   vocabulario; el código de feature lo CONSUME desde `ui-styles.ts`. La flecha
   va en una sola dirección.
   -------------------------------------------------------------------------- */

export interface EmptyStateProps extends React.HTMLAttributes<HTMLParagraphElement> {
  /**
   * Icono decorativo opcional (`lucide-react`). Siempre se marca
   * `aria-hidden`, porque el texto ya dice todo y el icono no aporta
   * información nueva a un lector de pantalla.
   */
  icon?: React.ComponentType<{ className?: string }>
}

const EmptyState = React.forwardRef<HTMLParagraphElement, EmptyStateProps>(
  ({ className, children, icon: Icon, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm text-text-secondary', className)} {...props}>
      {Icon ? <Icon className="mr-2 inline size-4 align-text-bottom" aria-hidden="true" /> : null}
      {children}
    </p>
  ),
)
EmptyState.displayName = 'EmptyState'

export { EmptyState }
