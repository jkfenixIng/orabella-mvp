import type { RoleCode } from "@/src/features/auth/schemas";

/**
 * Tipos y utilidades compartidas por las secciones del panel admin.
 *
 * Reexporta los helpers canónicos de `src/shared/lib` (mismo patrón que
 * `admin-styles.ts`) para que las secciones sigan importando desde acá sin
 * volver a declararlos. El hogar de cada uno es el módulo compartido.
 *
 * Se reexporta NOMBRE POR NOMBRE y no `export *`: `api-response.ts` importa
 * `next/server` y las secciones del panel son componentes cliente
 * (`"use client"`), así que un `export *` arrastraría el módulo de servidor al
 * bundle del navegador.
 */
export type { ActionResult } from "@/src/shared/lib/api-response";
export { toNumber } from "@/src/shared/lib/format";
export { formatMoney } from "@/src/shared/lib/money";

/** Status filter shared by the admin lists that carry `is_active`. */
export type ActiveStatusFilter = "all" | "active" | "inactive";

export const ACTIVE_STATUS_OPTIONS: Array<{ value: ActiveStatusFilter; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "active", label: "Activos" },
  { value: "inactive", label: "Inactivos" },
];

export function matchesActiveStatus(active: boolean, status: ActiveStatusFilter): boolean {
  return status === "all" || active === (status === "active");
}

/** Case-insensitive text match over the visible fields of a row; blank matches everything. */
export function matchesQuery(query: string, values: Array<string | null | undefined>): boolean {
  const needle = query.trim().toLocaleLowerCase("es-CO");
  return needle === "" || values.some((value) => value?.toLocaleLowerCase("es-CO").includes(needle));
}

/** Roles asignables desde el panel; compartido por empleados y usuarios. */
export const ROLE_OPTIONS: Array<{ value: RoleCode; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "caja", label: "Caja" },
  { value: "empleado", label: "Empleado" },
];
