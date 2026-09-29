/**
 * Fechas de negocio en la zona horaria de Colombia.
 *
 * America/Bogota es UTC-05:00 fijo todo el año (Colombia no tiene horario de
 * verano). Los timestamps se guardan como timestamptz (UTC); todo filtro por
 * fecha contra una columna timestamptz debe llevar el offset explícito, porque
 * sin él Postgres interpreta el literal en la zona de la sesión (UTC en
 * Supabase) y la ventana queda corrida 5 h: se cuelan registros de la noche
 * anterior (19:00-23:59) y faltan los de la noche del propio día.
 */

/** Offset fijo de Bogotá respecto de UTC (Colombia no tiene DST). */
export const BOGOTA_TZ_OFFSET = "-05:00";

/** Día calendario (yyyy-mm-dd) en America/Bogota para el instante dado. */
export function bogotaDay(offsetDays = 0, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Límites exactos (timestamptz, inclusivos) de un día calendario de Bogotá. */
export function dayBounds(fecha: string): { from: string; to: string } {
  return { from: `${fecha}T00:00:00${BOGOTA_TZ_OFFSET}`, to: `${fecha}T23:59:59.999${BOGOTA_TZ_OFFSET}` };
}

/** Límites exactos de un rango inclusivo de fechas de Bogotá. */
export function rangeBounds(desde: string, hasta: string): { from: string; to: string } {
  return { from: dayBounds(desde).from, to: dayBounds(hasta).to };
}

/**
 * Verdadero si un instante ISO (p. ej. el created_at de una factura, en UTC)
 * cae dentro del rango inclusivo de días de Bogotá [desde, hasta]. Se compara
 * por milisegundos para no depender del formato del literal. Puro, para
 * probar la semántica de la ventana sin base de datos.
 */
export function isInstantInBogotaRange(instant: string, desde: string, hasta: string): boolean {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return false;
  const { from, to } = rangeBounds(desde, hasta);
  return ms >= Date.parse(from) && ms <= Date.parse(to);
}
