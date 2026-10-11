import { isSedeAssignableRole, type RoleCode } from "@/src/features/auth/schemas";

/** Safety-net role for a newly linked employee without roles. */
export const DEFAULT_EMPLOYEE_ROLE = "empleado" as const satisfies RoleCode;

/** Pure policy owned by the application; SQL remains the atomic role writer. */
export function rolesAreNonEmpty(roles: readonly RoleCode[]): boolean {
  return roles.length > 0;
}

export function roleIsAssignableForSede(role: unknown): boolean {
  return isSedeAssignableRole(role);
}

/** A sede administrator must never grant or revoke the platform superadmin role. */
export function violatesSuperadminGuard(roles: readonly RoleCode[]): boolean {
  return roles.some((role) => !roleIsAssignableForSede(role));
}
