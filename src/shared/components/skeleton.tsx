interface SkeletonProps {
  className?: string;
}

/**
 * Bloque gris pulsante para los skeletons de `loading.tsx`.
 * Sin dependencias: solo Tailwind (`animate-pulse`).
 *
 * El color sale del token de superficie `bg-surface-hover`, que
 * design-tokens.css invierte en `.dark`: por eso no lleva variante `dark:` y
 * los llamadores solo pasan medidas (alto/ancho), nunca color.
 */
export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-md bg-surface-hover ${className}`}
    />
  );
}
