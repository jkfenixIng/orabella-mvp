/**
 * Helpers de formato compartidos por los módulos de la aplicación.
 *
 * Único hogar de `toNumber` y `formatDateTime`. Antes de WU3 `toNumber` estaba
 * copiado en cinco clientes (más una sexta copia en `admin-shared.ts`) y
 * `formatDateTime` en dos; `admin-shared.ts` ahora reexporta desde acá.
 */

/**
 * Convierte texto de un input a número, o `null` si no es un número usable.
 *
 * Contrato: recorta espacios; vacío es `null`; y todo lo que `Number()` no
 * pueda volver finito (texto no numérico, `Infinity`, `NaN`) es `null`. Usa
 * `Number()` directo, así que acepta notación exponencial y hexadecimal
 * ("1e3" → 1000, "0x10" → 16): es la conducta heredada de las copias, se
 * documenta para que cambiarla sea una decisión y no un accidente.
 */
export function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Formatea una fecha para MOSTRAR: día/mes y hora/minuto en es-CO.
 *
 * `null`, `undefined` y la cadena vacía rinden "—". Una fecha ilegible rinde
 * "Invalid Date" (conducta heredada: `toLocaleString` sobre un `Date`
 * inválido); no se corrige acá para no introducir conducta nueva en WU3.
 *
 * Nota: usa el huso del runtime, igual que las dos copias que reemplaza. El
 * huso de negocio (America/Bogota) vive en `src/shared/lib/dates.ts` y no es lo
 * que este formateador resuelve.
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-CO", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
