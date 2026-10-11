import { bogotaDay } from "@/src/shared/lib/dates";

/**
 * Helpers de formato compartidos por los módulos de la aplicación.
 *
 * Los instantes (`timestamptz`) se guardan exactos y se PRESENTAN siempre en
 * America/Bogota. Esta decisión reemplaza la D5 anterior (zona del navegador):
 * una pantalla con el reloj del equipo en otra zona mostraba otro día.
 */

/**
 * Convierte texto de un input a número, o `null` si no es un número usable.
 * Usa `Number()`: acepta notación exponencial y hexadecimal (conducta heredada).
 */
export function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

const BOGOTA_TIME_ZONE = "America/Bogota";
const EMPTY = "—";
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function formatBogotaInstant(value: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(value).toLocaleString("es-CO", { timeZone: BOGOTA_TIME_ZONE, ...options });
}

/** Día/mes y hora/minuto de un instante, en Bogotá. Ilegible rinde "Invalid Date". */
export function formatBogotaDateTime(value: string | null | undefined): string {
  if (!value) return EMPTY;
  return formatBogotaInstant(value, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Fecha y hora completas (con año) de un instante, en Bogotá. */
export function formatBogotaFullDateTime(value: string | null | undefined): string {
  if (!value) return EMPTY;
  return formatBogotaInstant(value, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Fecha civil (yyyy-mm-dd) de un instante en Bogotá; `bogotaDay` decide el día. */
export function bogotaDateOf(value: string): string | null {
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : bogotaDay(0, instant);
}

/** Fecha d/m/aaaa de un instante, según el día civil de Bogotá. */
export function formatBogotaDate(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const day = bogotaDateOf(value);
  return day === null ? value : formatCivilDate(day);
}

/** Fecha larga ("1 de octubre de 2026") de un instante, en Bogotá. */
export function formatBogotaLongDate(value: string | null | undefined): string {
  if (!value) return EMPTY;
  return formatBogotaInstant(value, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Formatea una columna `date` (yyyy-mm-dd) sin convertirla a instante: es una
 * fecha civil y no puede correrse un día por la zona del runtime.
 */
export function formatCivilDate(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const match = CIVIL_DATE.exec(value);
  if (!match) return value;
  return `${Number(match[3])}/${Number(match[2])}/${match[1]}`;
}

/** Compatibilidad: el formato de fecha y hora de las pantallas, ya en Bogotá. */
export const formatDateTime = formatBogotaDateTime;
