'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default: 'bg-primary-600 text-white hover:bg-primary-700 shadow-sm',
        destructive: 'bg-error-600 text-white hover:bg-error/90 shadow-sm',
        outline: 'border border-border-color bg-transparent hover:bg-surface-hover hover:text-text-primary',
        secondary: 'bg-surface-hover text-text-primary hover:bg-border-color-2',
        ghost: 'hover:bg-surface-hover hover:text-text-primary',
        link: 'text-primary-600 underline-offset-4 hover:underline dark:text-primary-400',
      },
      // R14 (medido en Chromium): `default` 40 px, `sm` 36 px y `icon`
      // 40×40, contra el objetivo táctil de 44 px de `docs/ux-ui-standard.md`
      // §8. El piso se aplica con `max-sm:`, o sea SOLO por debajo de 640: a
      // 1024 los 22 elementos interactivos medidos siguen en 36-40, y subir la
      // densidad de escritorio es una decisión aparte, no un token.
      //
      // `min-h-*` y no `h-*`: `min-height` le gana a `height` en el CSS, así que
      // abajo de `sm` el piso NO lo puede tumbar un `h-*` del llamador (que es
      // lo que hace que sea un piso y no una sugerencia) y arriba de `sm` no hay
      // `min-height` declarado, así que el llamador manda entero. Hoy ningún
      // llamador pasa un alto (`size` está en 1 de 19 usos de `<Button>`), así
      // que esto no le quita nada a nadie: lo verifica `tests/touch-floor.test.ts`.
      // Y en el icono el piso es en los dos ejes: 44×44 es lo que se toca.
      size: {
        default: 'h-10 px-4 py-2 max-sm:min-h-11',
        sm: 'h-9 rounded-md px-3 text-xs max-sm:min-h-11',
        lg: 'h-11 rounded-md px-8 text-base',
        xl: 'h-12 rounded-lg px-10 text-lg',
        icon: 'h-10 w-10 max-sm:h-11 max-sm:w-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading}
        {...props}
      >
        {loading && (
          <svg
            className="animate-spin h-4 w-4"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </Comp>
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }