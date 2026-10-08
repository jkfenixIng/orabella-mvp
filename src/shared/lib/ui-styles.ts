import { cn } from "@/src/components/ui/lib/utils";

/**
 * Estándar de estilos compartido de la aplicación.
 *
 * Único lugar donde viven las clases base del sistema de diseño. Los módulos
 * (panel admin, servicios, vales, inventario, nómina) importan de aquí en vez
 * de redeclarar cadenas de Tailwind. Las constantes específicas de un módulo
 * (por ejemplo botones de peligro o inputs de tabla) permanecen en su archivo.
 */

// R22 + R14 (medido en Chromium a 320 y a 1024, con la base con datos):
// `inputClass` computaba 14 px de fuente y 38-40 px de alto, `buttonClass` 36
// y `ghostClass` 38, contra el objetivo táctil de 44 px y el umbral de 16 px que
// dispara el zoom de iOS al enfocar (que a su vez mueve el layout mientras se
// escribe). MEDIDO a 1024 hay 22 elementos interactivos y los 22 están bajo 44:
// el piso faltante es de toda la aplicación, no del móvil.
//
// EL ARREGLO ES SOLO POR DEBAJO DE `sm`, y es deliberado:
//
//   - `text-base sm:text-sm`: 16 px en el dedo, 14 px en el escritorio. La
//     variante `sm:` es la mitad derecha del arreglo y no es decorativa: sin ella
//     la densidad de escritorio se va a 16 px en todos los formularios.
//   - `max-sm:min-h-11`: 44 px por debajo de 640 y NADA desde 640 en adelante.
//     Se usa `max-sm:` y no `sm:min-h-0` a propósito: `min-height: 0` en un
//     ítem flexible no es lo mismo que `auto` (puede dejar al botón por debajo
//     de su contenido), mientras que no declarar nada arriba de `sm` deja el
//     escritorio exactamente como estaba.
//
// El cambio de densidad de ESCRITORIO a 44 px se decide aparte: son 22 elementos
// medidos a 1024 y no es un token, es una decisión de densidad de la aplicación.

export const inputClass = cn(
  "rounded-md border border-border-color bg-surface px-3 py-2 text-base text-text-primary shadow-sm max-sm:min-h-11 sm:text-sm",
  "dark:border-border-color-2",
);

export const labelClass = cn("flex flex-col gap-1 text-sm text-text-primary");

export const buttonClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all duration-200 hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] max-sm:min-h-11",
);

export const ghostClass = cn(
  "inline-flex items-center justify-center gap-2 rounded-md border border-border-color bg-transparent px-4 py-2 text-sm font-medium text-text-primary shadow-sm transition-all duration-200 hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] max-sm:min-h-11",
  "dark:border-border-color-2 dark:hover:bg-surface-hover",
);

export const sectionClass = cn(
  "rounded-lg border border-border-color bg-surface p-4 shadow-sm",
  "dark:border-border-color-2",
);

export const mutedTextClass = cn("text-sm text-text-secondary");
export const hintTextClass = cn("text-xs text-text-tertiary");

// R13: el botón subrayado medía 20 px de alto y el censo lo cuenta 20 veces en
// Empleados, 50 en Roles, 22 en Caja, 15 en Vales, 6 en Métodos y 2 en
// Impuestos: se arregla UNA vez acá y los 115 usos lo reciben. Abajo de `sm`
// pasa a ser flex con `min-h-11` (44 px); arriba de `sm` queda exactamente como
// estaba, que es un enlace de texto de 20 px. `max-sm:inline-flex` va con el
// `min-h` porque un `<button>` en línea no suma alto: el `min-height` no aplica a
// una caja `inline`.
export const linkButtonClass = cn(
  "text-sm font-medium underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center",
);

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
