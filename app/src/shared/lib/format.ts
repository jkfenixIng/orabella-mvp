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
 * Huso horario de PRESENTACIÓN — decisión registrada (D5, opción b: dejarlo
 * como está). La app RAZONA en America/Bogota: `bogotaDay()`, `dayBounds()` y
 * `rangeBounds()` en `src/shared/lib/dates.ts` pasan `timeZone: "America/Bogota"`
 * al calcular el día calendario y el rango. Lo que se RENDERIZA, en cambio, sale
 * del huso del runtime: el `toLocaleString` de la línea de abajo no lleva
 * `timeZone`, así que usa el reloj de la máquina del usuario. Un usuario con el
 * sistema en otro huso ve las horas corridas respecto de alguien en Bogotá, sin
 * error, sin aviso y sin registro.
 *
 * Revisado y decidido: se deja así a propósito. La operación es de una sola sede
 * (`src/shared/lib/sede.ts`, `resolveSede`) con el personal en Colombia, así que
 * el corrimiento solo aparece en un cliente con el sistema mal configurado; y
 * fijar el huso acá cambiaría la fecha y hora de todas las pantallas que ya se
 * aceptaron (alertas, caja, nómina, vales) sin una necesidad medida. Si algún día
 * se decide fijarlo, el punto ÚNICO es esta función (`timeZone: "America/Bogota"`
 * en las opciones de abajo), no `dates.ts`: ese archivo es el huso del CÁLCULO de
 * negocio, no el de la presentación.
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
