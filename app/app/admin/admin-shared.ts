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

/** Roles asignables desde el panel; compartido por empleados y usuarios. */
export const ROLE_OPTIONS: Array<{ value: RoleCode; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "caja", label: "Caja" },
  { value: "empleado", label: "Empleado" },
];
