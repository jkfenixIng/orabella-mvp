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
