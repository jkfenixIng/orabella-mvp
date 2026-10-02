import { z } from "zod";

/** Tipo de identificación (users.id_type). */
export const idTypeSchema = z.enum(["CC", "CE", "PPT", "PEP", "otro"]);
export type IdType = z.infer<typeof idTypeSchema>;

/** Roles fijos del MVP (AUTH-07). Sin permisos granulares. */
export const roleCodeSchema = z.enum(["admin", "empleado", "caja"]);
export type RoleCode = z.infer<typeof roleCodeSchema>;

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
 */
export const adminCreateUserSchema = z.object({
  email: z.email("Correo inválido."),
  documento: documentoSchema,
  id_type: idTypeSchema,
  full_name: z.string().trim().min(2, "Nombre requerido.").max(120),
  phone: z.string().trim().max(30).optional(),
  roles: z.array(roleCodeSchema).length(1, "Un solo rol por usuario."),
  sede_id: z.uuid("Sede inválida.").nullable().optional(),
});
export type AdminCreateUserInput = z.infer<typeof adminCreateUserSchema>;
