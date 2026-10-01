import * as React from 'react'

import { cn } from './utils'

/* --------------------------------------------------------------------------
   PageContainer / PageHeader — el shell de página, escrito una sola vez.

   El problema que cierran: los `app/<dir>/page.tsx` repetían a mano
   `mx-auto flex min-h-screen max-w-{3xl|4xl|5xl} flex-col gap-{4|6} px-6 py-12`
   y su propio `<h1>`; tres anchos sin criterio y el título cambiando de
   `text-2xl` a `text-3xl` según la rama del MISMO archivo.

   Dos reglas son el punto entero del primitivo:

   1. Nada de `min-h-screen`. `app-shell.tsx` ya la declara en su raíz y su
      `lg:flex` estira al hijo. Acá va `min-h-dvh lg:min-h-0`: en móvil `100vh`
      incluye la barra del navegador y deja un scroll fantasma en páginas
      cortas; en escritorio la altura la resuelve el estirón del shell.
   2. El `<h1>` es SIEMPRE `text-3xl font-bold`, una sola vez por página, y vive
      acá. Ninguna página lo escribe a mano.

   Sin `'use client'`: no usa hooks, estado ni handlers, así que el mismo
   archivo sirve desde un Server Component y desde un Client Component (mismo
   criterio que `alert.tsx` y `empty-state.tsx`). Quien pase un handler ya está,
   por definición, en un módulo cliente.
   -------------------------------------------------------------------------- */

/**
 * Criterio del ancho: lo decide el CONTENIDO, no la costumbre.
 *   narrow  -> max-w-md   : ingreso y mensajes de pantalla completa
 *   default -> max-w-4xl  : contenido general, formularios, listados de tarjetas
 *   wide    -> max-w-5xl  : listados con tabla ancha
 */
const SIZE = {
  narrow: 'max-w-md',
  default: 'max-w-4xl',
  wide: 'max-w-5xl',
} as const

export type PageSize = keyof typeof SIZE

export type PageContainerProps = React.HTMLAttributes<HTMLElement> & {
  /** `narrow` | `default` | `wide`; sin pasarlo, `default`. */
  size?: PageSize
}

export function PageContainer({
  size = 'default',
  className,
  children,
  ...props
}: PageContainerProps) {
  return (
    <main
      className={cn(
        'mx-auto flex min-h-dvh lg:min-h-0 w-full flex-col gap-6 px-6 py-12',
        SIZE[size],
        className,
      )}
      {...props}
    >
      {children}
    </main>
  )
}

/**
 * `title` sale del `Omit` porque colisiona con el atributo HTML homónimo (el
 * tooltip nativo): acá el título es VISIBLE y estructurante —es el `<h1>`—, no
 * un tooltip, así que la prop se reescribe como nodo de React. Mismo criterio
 * que `AlertProps` en `alert.tsx`.
 */
export type PageHeaderProps = Omit<React.HTMLAttributes<HTMLElement>, 'title'> & {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
}

export function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header
      className={cn('flex flex-wrap items-start justify-between gap-4', className)}
      {...props}
    >
      <div>
        <h1 className="text-3xl font-bold">{title}</h1>
        {description ? <p className="mt-2 text-text-secondary">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </header>
  )
}
