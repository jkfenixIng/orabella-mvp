'use client'

import * as React from 'react'
import { cn } from './utils'

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean
  icon?: React.ReactNode
  leadingIcon?: React.ReactNode
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, error, icon, leadingIcon, ...props }, ref) => {
    const classes = cn(
      'flex h-10 w-full items-center rounded-lg border bg-surface px-3 text-sm text-text-primary placeholder:text-text-tertiary outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50',
      error && 'border-error-600 focus-visible:ring-2 focus-visible:ring-error-600/20',
      !error && 'border-border-color hover:border-border-color-2 focus:border-primary-600 focus:ring-2 focus:ring-primary-600/20',
      className,
    )

    if (leadingIcon) {
      return (
        <div className="relative">
          <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary">
            {leadingIcon}
          </div>
          <input
            ref={ref}
            className={cn(classes, 'pl-10')}
            {...props}
          />
        </div>
      )
    }

    return (
      <input
        ref={ref}
        className={cn(classes, icon && 'pr-10')}
        {...props}
      />
    )
  },
)
Input.displayName = 'Input'

export { Input }
