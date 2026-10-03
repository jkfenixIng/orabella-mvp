import { z } from "zod";

/** Tipo de identificación (users.id_type). */
export const idTypeSchema = z.enum(["CC", "CE", "PPT", "PEP", "otro"]);
export type IdType = z.infer<typeof idTypeSchema>;

/**
 * Roles fijos del MVP (AUTH-07) más el rol de PLATAFORMA `superadmin` (G1).
 * `superadmin` existe en el catálogo (069) para la cuenta del dueño, pero NO se
 * asigna ni se quita desde la administración de una sede: para eso está
 * `sedeAssignableRoleSchema`. Sin permisos granulares.
 */
export const roleCodeSchema = z.enum(["admin", "empleado", "caja", "superadmin"]);
export type RoleCode = z.infer<typeof roleCodeSchema>;

/**
 * Verdadero si `code` es uno de los códigos del catálogo. Derivado del esquema
 * —y no de una lista de literales repetida— para que agregar un rol nuevo no
 * obligue a acordarse de cada punto que filtra roles: el defecto que dejaba al
 * `superadmin` fuera de la sesión.
 */
export function isRoleCode(code: unknown): code is RoleCode {
  return roleCodeSchema.safeParse(code).success;
}

/**
 * Esquema de los roles que la administración de una SEDE puede asignar o
 * quitar. `superadmin` queda FUERA: solo lo otorga la plataforma.
 */
export const sedeAssignableRoleSchema = z.enum(["admin", "empleado", "caja"]);
export type SedeAssignableRole = z.infer<typeof sedeAssignableRoleSchema>;

/**
 * ÚNICA lista de roles asignables desde sede, derivada del esquema. La
 * comparten las DOS puertas que otorgan un rol (el alta `adminCreateUserSchema`
 * y el reemplazo `setUserRoles`), para que no existan dos listas que puedan
 * divergir.
 */
export const SEDE_ASSIGNABLE_ROLES = sedeAssignableRoleSchema.options;

/** Verdadero si `code` es un rol asignable desde la administración de una sede. */
export function isSedeAssignableRole(code: unknown): code is SedeAssignableRole {
  return sedeAssignableRoleSchema.safeParse(code).success;
}

/** Documento de acceso: el "usuario" del login (AUTH-01). */
const documentoSchema = z
  .string()
  .trim()
  .min(3, "Documento inválido.")
  .max(20, "Documento inválido.");

/**
 * Política mínima de clave (AUTH-02): 8+ caracteres con letra y número.
 * Solo se valida en servidor; el navegador es ayuda visual.
 */
const passwordPolicySchema = z
  .string()
  .min(8, "La clave debe tener al menos 8 caracteres.")
  .max(72, "La clave debe tener máximo 72 caracteres.")
  .regex(/[A-Za-z]/, "La clave debe incluir al menos una letra.")
  .regex(/[0-9]/, "La clave debe incluir al menos un número.");

/** POST /api/v1/auth/login */
export const loginSchema = z.object({
  documento: documentoSchema,
  password: z.string().min(1, "Clave requerida.").max(128, "Clave inválida."),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** POST /api/v1/auth/password:change */
export const changePasswordSchema = z.object({
  actual: z.string().min(1, "Clave actual requerida.").max(128),
  nueva: passwordPolicySchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** POST /api/v1/auth/password-reset:request */
export const requestResetSchema = z.object({
  documento: documentoSchema,
});
export type RequestResetInput = z.infer<typeof requestResetSchema>;

/** POST /api/v1/auth/password-reset:confirm */
export const resetPasswordSchema = z.object({
  token: z.string().trim().min(1, "Token requerido.").max(256),
  nueva: passwordPolicySchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/**
 * Alta solo por admin (AUTH-04: 0 rutas públicas de creación).
 * Exige correo REAL (sin emails sintéticos tipo id@orabella.local):
 * quien no tenga correo no puede crearse en T2.
 *
 * `sede_id` sigue declarado porque su único destino es el ARGUMENTO `p_user` de
 * `create_user_with_role` (054), que es contrato de la base y este cambio no
 * toca. No es un alcance por sede de la petición: nada de este módulo lo usa
 * para filtrar ni para comparar filas.
 */
export const adminCreateUserSchema = z.object({
  email: z.email("Correo inválido."),
  documento: documentoSchema,
  id_type: idTypeSchema,
  full_name: z.string().trim().min(2, "Nombre requerido.").max(120),
  phone: z.string().trim().max(30).optional(),
  roles: z.array(sedeAssignableRoleSchema).length(1, "Un solo rol por usuario."),
  sede_id: z.uuid("Sede inválida.").nullable().optional(),
});
export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;
