import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from './utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-none transition-colors',
  {
    variants: {
      variant: {
        // Las clases .bg-*-light y .text-* (design-tokens.css) son clases
        // custom con override propio en .dark; los peldaños -50/-200/-700/-800
        // no están expuestos en @theme y no generaban ninguna utilidad.
        default:
          'border-transparent bg-primary-light text-primary-color',
        secondary:
          'border-border-color bg-surface-hover text-text-secondary',
        success:
          'border-transparent bg-success-light text-success',
        warning:
          'border-transparent bg-warning-light text-warning',
        destructive:
          'border-transparent bg-error-light text-error',
        outline: 'border-border-color bg-transparent text-text-secondary',
      },
      size: {
        default: 'h-5 px-2.5',
        sm: 'h-4 px-2',
        lg: 'h-6 px-3',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
}

export { Badge, badgeVariants }
