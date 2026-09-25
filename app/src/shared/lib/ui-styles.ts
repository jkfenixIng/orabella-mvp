import { cn } from "@/src/components/ui/lib/utils";

/**
 * Estándar de estilos compartido de la aplicación.
 *
 * Único lugar donde viven las clases base del sistema de diseño. Los módulos
 * (panel admin, servicios, vales, inventario, nómina) importan de aquí en vez
 * de redeclarar cadenas de Tailwind. Las constantes específicas de un módulo
 * (por ejemplo botones de peligro o inputs de tabla) permanecen en su archivo.
 */

export const inputClass = cn(
  "rounded-md border border-border-color bg-surface px-3 py-2 text-sm text-text-primary shadow-sm",
  "dark:border-border-color-2",
);

export const labelClass = cn("flex flex-col gap-1 text-sm text-text-primary");

export const buttonClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
);

export const ghostClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md border border-border-color bg-transparent px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-all duration-200 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]",
  "dark:border-border-color-2 dark:hover:bg-surface-hover",
);

export const sectionClass = cn(
  "rounded-lg border border-border-color bg-surface p-4 shadow-sm",
  "dark:border-border-color-2",
);

export const errorClass = cn("text-sm text-error dark:text-error");
export const okClass = cn("text-sm text-success dark:text-success");
export const mutedTextClass = cn("text-sm text-text-secondary");
export const hintTextClass = cn("text-xs text-text-tertiary");

export const linkButtonClass = cn("text-sm font-medium underline");

export const tableHeaderClass = cn(
  "bg-surface-hover text-xs font-semibold uppercase text-text-tertiary",
);
export const tableCellClass = cn("px-3 py-2 align-middle");
export const tableRowClass = cn("border-t border-border-color dark:border-border-color-2");

export const listItemClass = cn(
  "flex flex-wrap items-center gap-2 rounded border border-border-color-2 px-3 py-2 text-sm",
);

export const stackClass = cn("flex flex-col gap-4");
export const sectionTitleClass = cn("text-lg font-semibold");
