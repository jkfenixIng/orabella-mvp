import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from './utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-none transition-colors',
  {
    variants: {
      variant: {
        default:
          'border-primary-200 bg-primary-50 text-primary-700 dark:border-primary-800 dark:bg-primary-900 dark:text-primary-50',
        secondary:
          'border-secondary-200 bg-secondary-50 text-secondary-700 dark:border-secondary-800 dark:bg-secondary-800 dark:text-secondary-50',
        success:
          'border-success-200 bg-success-50 text-success-700 dark:border-success-800 dark:bg-success-900 dark:text-success-50',
        warning:
          'border-warning-200 bg-warning-50 text-warning-700 dark:border-warning-800 dark:bg-warning-900 dark:text-warning-50',
        destructive:
          'border-error-200 bg-error-50 text-error-700 dark:border-error-800 dark:bg-error-900 dark:text-error-50',
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
