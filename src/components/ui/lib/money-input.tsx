'use client'

import * as React from 'react'
import { formatMoneyInput, stripMoneyInput } from '@/src/shared/lib/money'
import { cn } from './utils'

export interface MoneyInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> {
  /** Digits only (no separators). Empty string renders an empty field. */
  value: string
  /** Receives digits only, ready for `Number(...)`. */
  onValueChange: (digits: string) => void
  /** Classes for the wrapper (width, margins). `className` styles the input. */
  wrapperClassName?: string
}

/**
 * COP amount field: a fixed "$" prefix inside the input and thousands grouping
 * while typing. State stays as digits, so callers keep their existing contracts.
 */
const MoneyInput = React.forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ value, onValueChange, className, wrapperClassName, ...props }, ref) => (
    <div className={cn('relative', wrapperClassName)}>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-tertiary"
      >
        $
      </span>
      <input
        ref={ref}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={formatMoneyInput(value)}
        onChange={(event) => onValueChange(stripMoneyInput(event.target.value))}
        className={cn(className, '!pl-7 text-right tabular-nums')}
        {...props}
      />
    </div>
  ),
)
MoneyInput.displayName = 'MoneyInput'

export { MoneyInput }
