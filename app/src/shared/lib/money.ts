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
