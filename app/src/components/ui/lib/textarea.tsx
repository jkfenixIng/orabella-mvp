'use client'

import * as React from 'react'
import { cn } from './utils'

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, error, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-[80px] w-full resize-y rounded-lg border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary outline-none transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50',
        error && 'border-error-600 focus-visible:ring-2 focus-visible:ring-error-600/20',
        !error && 'border-border-color hover:border-border-color-2 focus:border-primary-600 focus:ring-2 focus:ring-primary-600/20',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'

export { Textarea }
