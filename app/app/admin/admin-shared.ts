import type { RoleCode } from "@/src/features/auth/schemas";

/**
 * Tipos y utilidades compartidas por las secciones del panel admin.
 */

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; code: string; message: string };

export function toNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMoney(value: number | string | null): string {
  if (value === null || value === undefined) return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(numeric);
}

/** Roles asignables desde el panel; compartido por empleados y usuarios. */
export const ROLE_OPTIONS: Array<{ value: RoleCode; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "caja", label: "Caja" },
  { value: "empleado", label: "Empleado" },
];
