import * as React from 'react'

import { cn } from './utils'

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>

/**
 * Decorative loading block, hidden from assistive tech: the route container
 * carries `aria-busy` and a `role="status"` text. The pulse only runs when the
 * user allows motion.
 */
export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-md bg-surface-hover motion-safe:animate-pulse motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  )
}
