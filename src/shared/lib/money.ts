/**
 * Moneda de la aplicación (COP sin decimales, como el resto de la app).
 *
 * Este módulo es el ÚNICO hogar de los helpers de dinero: el formateo de
 * despliegue (`formatMoney`) y la máscara de captura (`formatMoneyInput` /
 * `stripMoneyInput`). Antes de WU3 `formatMoney` estaba copiado en siete
 * clientes, con marcadores de vacío distintos entre ellos.
 */

/**
 * Formatea un monto para MOSTRAR: pesos colombianos, sin decimales.
 *
 * Contrato de vacío (WU3): `null`, `undefined` y todo valor no finito (`NaN`,
 * `Infinity`, texto no numérico) rinden el guion largo "—". Las copias antiguas
 * de caja, nómina y vales usaban el guion simple "-" para ese mismo caso; se
 * normalizó deliberadamente en "—".
 *
 * Ojo: un string vacío NO es marcador de vacío — `Number("")` es 0 — así que
 * rinde "$ 0". Es la conducta heredada de las ocho copias y no se cambió acá.
 *
 * Acepta `number | string | null | undefined`: es la unión de las ocho firmas
 * anteriores (siete aceptaban number o string; la de inventario solo number).
 */
export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(numeric);
}

/**
 * Máscara de moneda (COP sin decimales, como el resto de la app).
 * El estado guarda solo dígitos; la vista muestra miles agrupados.
 */
export function formatMoneyInput(digits: string): string {
  const clean = digits.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  if (clean === "") return "";
  return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 }).format(Number(clean));
}

/** Extrae solo dígitos de un valor con máscara (listo para toNumber). */
export function stripMoneyInput(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * Máscara de CANTIDAD: conserva solo dígitos (0-9) de lo tecleado o pegado.
 *
 * El estado guarda dígitos sin ceros a la izquierda, igual que la máscara de
 * dinero (`formatMoneyInput`): "007" rinde "7" y "0" se conserva para que el
 * cero sea tecleable. El texto vacío sigue siendo vacío, para que el campo
 * pueda quedar en blanco mientras se edita.
 *
 * Todo lo que no sea un dígito ASCII se descarta: letras ("12a"), espacios
 * ("1 2"), separadores ("12,5"), signos y dígitos de ancho completo ("１２")
 * no sobreviven. Una cantidad ya válida vuelve sin cambios ("7" → "7").
 */
export function stripQuantityInput(value: string): string {
  return value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
}

/**
 * Máscara de PORCENTAJE: conserva dígitos y, como máximo, UN separador
 * decimal.
 *
 * El porcentaje sí puede llevar decimales (a diferencia del dinero COP y de
 * las cantidades, que son enteros), así que esta máscara no puede descartar el
 * separador: `7,5` es siete y medio, no setenta y cinco. Acepta coma y punto, y
 * normaliza la coma a punto para que `Number(...)` lo entienda (`"7,5"` →
 * `"7.5"`). Si el texto trae más de un separador, solo el primero cuenta: los
 * demás se descartan y los dígitos que seguían se pegan a los decimales
 * (`"7..5"` → `"7.5"`, `"7,5,5"` → `"7.55"`).
 *
 * Todo lo demás se descarta (letras, espacios, signos, dígitos de ancho
 * completo). El texto vacío —y el que queda sin dígitos, como `"."`— sigue
 * vacío para que el campo pueda quedar en blanco mientras se edita. Un
 * porcentaje ya válido vuelve sin cambios (`"100"` → `"100"`, `"7.5"` →
 * `"7.5"`).
 */
export function stripPercentageInput(value: string): string {
  const clean = value.replace(/,/g, ".").replace(/[^\d.]/g, "");
  const separator = clean.indexOf(".");
  if (separator === -1) return clean;
  const integer = clean.slice(0, separator);
  const decimals = clean.slice(separator + 1).replace(/\./g, "");
  if (integer === "" && decimals === "") return "";
  return `${integer}.${decimals}`;
}
