import { z } from "zod";
import { roleCodeSchema } from "@/src/features/auth/schemas";

/** ADM-08: esquemas de sueldo por empleado. */
export const payTypeSchema = z.enum(["fijo", "porcentaje", "mixto"]);
export type PayType = z.infer<typeof payTypeSchema>;

/** ADM-07: catálogo de métodos de pago de Colombia por sede. */
export const paymentMethodCodeSchema = z.enum([
  "efectivo",
  "transferencia_normal",
  "nequi",
  "daviplata",
  "bre-b",
  "tarjeta",
]);
export type PaymentMethodCode = z.infer<typeof paymentMethodCodeSchema>;

/** ADM-06: códigos de impuesto configurables por sede. */
export const taxCodeSchema = z.enum(["IVA", "ICA", "Rete", "otro"]);
export type TaxCode = z.infer<typeof taxCodeSchema>;

const uuidSchema = z.uuid("Identificador inválido.");
const sedeIdSchema = z.uuid("Sede inválida.");
export const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} muy largo.`).optional();

/** ADM-01: sede (nombre, dirección, teléfono, activa/inactiva). */
export const sedeSchema = z.object({
  id: uuidSchema.optional(),
  name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
  address: z.string().trim().max(200, "Dirección muy larga.").nullish(),
  phone: z.string().trim().max(30, "Teléfono muy largo.").nullish(),
  is_active: z.boolean().optional(),
});
export type SedeInput = z.infer<typeof sedeSchema>;

/**
 * ADM-03: normaliza el código de empleado. Vacío / solo espacios / nulo
 * se guarda como null (repetible por sede); con valor se compara exacto.
 */
export function normalizeEmployeeCode(code: string | null | undefined): string | null {
  if (code == null) return null;
  const trimmed = code.trim();
  return trimmed === "" ? null : trimmed;
}

/** ADM-03: true cuando el código cuenta como "sin valor" (repetible). */
export function isEmployeeCodeMissing(code: string | null | undefined): boolean {
  return normalizeEmployeeCode(code) === null;
}

/**
 * ADM-03: conflicto de unicidad parcial a nivel app (además del índice
 * uq_employees_sede_code). Dos códigos con valor iguales en la misma sede
 * colisionan; los vacíos/nulos nunca colisionan.
 */
export function areEmployeeCodesConflicting(args: {
  sedeIdA: string;
  codeA: string | null | undefined;
  sedeIdB: string;
  codeB: string | null | undefined;
}): boolean {
  if (args.sedeIdA !== args.sedeIdB) return false;
  const a = normalizeEmployeeCode(args.codeA);
  const b = normalizeEmployeeCode(args.codeB);
  if (a === null || b === null) return false;
  return a === b;
}

/**
 * ADM-08: coherencia pay_type ↔ montos. Null cuando es coherente, mensaje
 * en español cuando no. Reglas: fijo exige salary_fixed (sin comisión);
 * porcentaje exige commission_percent (sin fijo); mixto exige ambos.
 */
export function checkPayCoherence(args: {
  pay_type: PayType;
  salary_fixed: number | null | undefined;
  commission_percent: number | null | undefined;
}): string | null {
  const { pay_type: payType, salary_fixed: fixed, commission_percent: percent } = args;
  switch (payType) {
    case "fijo":
      if (fixed == null) return "El sueldo fijo exige un salario fijo.";
      if (percent != null) return "El sueldo fijo no lleva comisión porcentual.";
      return null;
    case "porcentaje":
      if (percent == null) return "El sueldo por porcentaje exige una comisión porcentual.";
      if (fixed != null) return "El sueldo por porcentaje no lleva salario fijo.";
      return null;
    case "mixto":
      if (fixed == null || percent == null) {
        return "El sueldo mixto exige salario fijo y comisión porcentual.";
      }
      return null;
  }
}

/** ADM-02/ADM-08: empleado con nombre propio y sueldo fijo/porcentaje/mixto.
 * El vínculo al usuario es automático por documento (no se recibe). */
export const employeeSchema = z
  .object({
    id: uuidSchema.optional(),
    sede_id: sedeIdSchema,
    full_name: z.string().trim().min(2, "Nombre requerido.").max(120, "Nombre muy largo."),
    employee_code: z.string().trim().max(40, "Código muy largo.").nullish(),
    document: z.string().trim().min(3, "Documento inválido.").max(20, "Documento inválido."),
    phone: z.string().trim().max(30, "Teléfono muy largo.").nullish(),
    position: z.string().trim().max(80, "Cargo muy largo.").nullish(),
    payout_mode: z.enum(["nomina", "inmediato", "no_aplica"]).optional(),
    email: z.email("Correo inválido.").nullish(),
    birth_date: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (use yyyy-mm-dd).")
      .refine((value) => value <= new Date().toISOString().slice(0, 10), "La fecha no puede ser futura.")
      .nullish(),
    pay_type: payTypeSchema,
    salary_fixed: z.coerce.number().nonnegative("El salario no puede ser negativo.").nullish(),
    commission_percent: z.coerce
      .number()
      .min(0, "La comisión mínima es 0%.")
      .max(100, "La comisión máxima es 100%.")
      .nullish(),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    const message = checkPayCoherence({
      pay_type: value.pay_type,
      salary_fixed: value.salary_fixed,
      commission_percent: value.commission_percent,
    });
    if (message) {
      context.addIssue({ code: "custom", message });
    }
  });
export type EmployeeInput = z.infer<typeof employeeSchema>;

/** ADM-05: servicio facturable con rango de duración en minutos. */
export const serviceSchema = z
  .object({
    id: uuidSchema.optional(),
    sede_id: sedeIdSchema,
    name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
    description: z.string().trim().max(500, "Descripción muy larga.").nullish(),
    price: z.coerce.number().nonnegative("El precio no puede ser negativo."),
    duracion_min: z.coerce.number().int("Minutos enteros.").nonnegative("La duración mínima no puede ser negativa."),
    duracion_max: z.coerce.number().int("Minutos enteros.").nonnegative("La duración máxima no puede ser negativa."),
    is_active: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.duracion_min > value.duracion_max) {
      context.addIssue({
        code: "custom",
        message: "La duración mínima no puede superar a la máxima.",
      });
    }
  });
export type ServiceInput = z.infer<typeof serviceSchema>;

/** ADM-06: impuesto configurable por sede (inician inactivos en 0). */
export const taxConfigSchema = z.object({
  id: uuidSchema.optional(),
  sede_id: sedeIdSchema,
  code: taxCodeSchema,
  name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
  percent: z.coerce.number().min(0, "El porcentaje mínimo es 0.").max(100, "El porcentaje máximo es 100."),
  is_active: z.boolean().optional(),
});
export type TaxConfigInput = z.infer<typeof taxConfigSchema>;

/** ADM-07: método de pago del catálogo Colombia por sede. */
export const paymentMethodSchema = z.object({
  id: uuidSchema.optional(),
  sede_id: sedeIdSchema,
  code: paymentMethodCodeSchema,
  name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
  is_active: z.boolean().optional(),
  arqueable: z.boolean().optional(),
  fee_percent: z.coerce.number().min(0).max(100).optional(),
});
export type PaymentMethodInput = z.infer<typeof paymentMethodSchema>;

/** ADM-04: asignación de rol único por usuario. */
export const setUserRolesSchema = z.object({
  user_id: uuidSchema,
  roles: z.array(roleCodeSchema).length(1, "Un solo rol por usuario."),
});
export type SetUserRolesInput = z.infer<typeof setUserRolesSchema>;
