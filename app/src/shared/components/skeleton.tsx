interface SkeletonProps {
  className?: string;
}

/**
 * Bloque gris pulsante para los skeletons de `loading.tsx`.
 * Sin dependencias: solo Tailwind (`animate-pulse`).
 */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-slate-200 dark:bg-slate-700 ${className}`}
    />
  );
}
