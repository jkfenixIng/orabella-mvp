import { z } from "zod";
import { roleCodeSchema } from "@/src/features/auth/schemas";
import { bogotaDay } from "@/src/shared/lib/dates";
import { copSchema } from "@/src/shared/money/cop";

/** ADM-08: esquemas de sueldo por empleado. */
export const payTypeSchema = z.enum(["fijo", "porcentaje", "mixto"]);
export type PayType = z.infer<typeof payTypeSchema>;

/** F2: cadencia de pago acordada con el empleado (`employees.pay_frequency`,
 * 063). Semanal paga el fijo mensual / 4, quincenal / 2 y mensual completo,
 * sobre un mes comercial de 30 días; la fracción la aplica la nómina. Es un
 * catálogo CERRADO: una cuarta cadencia no es algo que la nómina sepa liquidar. */
export const payFrequencySchema = z.enum(["semanal", "quincenal", "mensual"]);
export type PayFrequency = z.infer<typeof payFrequencySchema>;

/** ADM-07/003: a stable free identifier, normalized by the service before Zod. */
export const paymentMethodCodeSchema = z.string()
  .min(2, "El código debe tener al menos 2 caracteres.")
  .max(40, "El código es muy largo.")
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, "Use minúsculas, números, guion o guion bajo.");
export type PaymentMethodCode = z.infer<typeof paymentMethodCodeSchema>;
export const arqueoModeSchema = z.enum(["none", "denominations", "declared_total"]);
export type ArqueoMode = z.infer<typeof arqueoModeSchema>;

export function normalizePaymentMethodCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s+/g, "-");
}

/** ADM-06: códigos de impuesto configurables de la instalación. */
export const taxCodeSchema = z.enum(["IVA", "ICA", "Rete", "otro"]);
export type TaxCode = z.infer<typeof taxCodeSchema>;

const uuidSchema = z.uuid("Identificador inválido.");
export const optionalText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} muy largo.`).optional();

/**
 * ADM-01: sede (nombre, dirección, teléfono, activa/inactiva).
 *
 * La fila de `sedes` sigue existiendo y describe LA instalación (una sola), así
 * que el esquema de la fila no cambia. Lo que se retiró es el catálogo de sedes
 * del negocio: no hay ni alta ni lista de sedes en la administración.
 */
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
 * uq_employees_sede_code). Dos códigos con valor iguales colisionan; los
 * vacíos/nulos nunca colisionan.
 *
 * Ya NO lleva la sede de cada lado: `uq_employees_sede_code` se recreó sobre
 * `(employee_code, …)` sin la sede (074), así que la restricción que este
 * predicado refleja compara sólo el código. Comparar las dos sedes era una
 * frontera de fila que únicamente tenía sentido con varias instalaciones; con
 * una sola, los dos lados son siempre la misma fila de negocio y el resultado
 * no podía cambiar.
 */
export function areEmployeeCodesConflicting(args: {
  codeA: string | null | undefined;
  codeB: string | null | undefined;
}): boolean {
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
      .refine((value) => value <= bogotaDay(), "La fecha no puede ser futura.")
      .nullish(),
    pay_type: payTypeSchema,
    // F2: OPCIONAL y `nullish`. El nulo es un valor legal y significa "sin
    // cadencia definida": el fijo se sigue prorrateando por los días del
    // período, que es el comportamiento de hoy. Sólo se cierra el catálogo.
    pay_frequency: payFrequencySchema.nullish(),
    salary_fixed: copSchema("El salario no puede ser negativo.").nullish(),
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
    name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
    description: z.string().trim().max(500, "Descripción muy larga.").nullish(),
    price: copSchema("El precio no puede ser negativo."),
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

/** ADM-06: impuesto configurable de la instalación (inician inactivos en 0). */
export const taxConfigSchema = z.object({
  id: uuidSchema.optional(),
  code: taxCodeSchema,
  name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
  percent: z.coerce.number().min(0, "El porcentaje mínimo es 0.").max(100, "El porcentaje máximo es 100."),
  is_active: z.boolean().optional(),
});
export type TaxConfigInput = z.infer<typeof taxConfigSchema>;

/** ADM-07/003: payment method code is only accepted on creation. */
export const paymentMethodSchema = z.object({
  id: uuidSchema.optional(),
  code: z.string().trim().optional(),
  name: z.string().trim().min(1, "Nombre requerido.").max(120, "Nombre muy largo."),
  is_active: z.boolean().optional(),
  arqueo_mode: arqueoModeSchema.optional(),
  fee_percent: z.coerce.number().min(0).max(100).optional(),
}).superRefine((value, context) => {
  if (!value.id && !value.code) {
    context.addIssue({ code: "custom", path: ["code"], message: "Código requerido." });
    return;
  }
  if (value.code) {
    const normalized = normalizePaymentMethodCode(value.code);
    const parsed = paymentMethodCodeSchema.safeParse(normalized);
    if (!parsed.success) context.addIssue({ code: "custom", path: ["code"], message: parsed.error.issues[0]?.message ?? "Código inválido." });
  }
});
export type PaymentMethodInput = z.infer<typeof paymentMethodSchema>;

/** ADM-04: asignación de rol único por usuario. */
export const setUserRolesSchema = z.object({
  user_id: uuidSchema,
  roles: z.array(roleCodeSchema).length(1, "Un solo rol por usuario."),
});
export type SetUserRolesInput = z.infer<typeof setUserRolesSchema>;
