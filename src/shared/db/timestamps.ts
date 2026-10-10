/**
 * Timestamps on the direct PostgreSQL path, in the shape PostgREST returns.
 *
 * PostgREST serializes a `timestamptz` with `to_json`: XSD/ISO 8601 in the
 * session time zone of the database, `2026-10-09T14:32:18.123456-05:00`
 * (`T` separator, fraction exactly as PostgreSQL prints it — up to
 * microseconds, no trailing zeros, absent when zero — and the offset always
 * with minutes). Drizzle in `string` mode returns the text output of the same
 * value in the same session time zone: `2026-10-09 14:32:18.123456-05`.
 *
 * Both come from the same database settings, so the conversion is purely
 * textual: `T` instead of the space and `:00` minutes on an hour-only offset.
 * The instant, the fraction and the offset are kept, never re-zoned.
 *
 * Pure module (no driver import).
 */
const PG_TIMESTAMPTZ =
  /^(\d{4,}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)([+-]\d{2})(:\d{2})?(:\d{2})?( BC)?$/;

/** `timestamptz` text to the string PostgREST returns for it (`null` stays `null`). */
export function toPostgrestTimestamp(value: string): string;
export function toPostgrestTimestamp(value: string | null): string | null;
export function toPostgrestTimestamp(value: string | null): string | null {
  if (value === null) return null;
  if (value === "infinity" || value === "-infinity") return value;
  const match = PG_TIMESTAMPTZ.exec(value);
  if (!match || match[6]) throw new Error(`Not a PostgreSQL timestamptz: ${value}`);
  const [, day, time, hours, minutes = ":00", seconds = ""] = match;
  return `${day}T${time}${hours}${minutes}${seconds}`;
}
