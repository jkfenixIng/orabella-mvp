import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  areEmployeeCodesConflicting,
  checkPayCoherence,
  employeeSchema,
  isEmployeeCodeMissing,
  normalizeEmployeeCode,
  paymentMethodSchema,
  sedeSchema,
  serviceSchema,
  setUserRolesSchema,
  taxConfigSchema,
} from "@/src/features/admin/schemas";
import { AdminError, requireSedeRole, resolveSede } from "@/src/features/admin/service";

const SEDE_A = "11111111-1111-4111-8111-111111111111";
const SEDE_B = "22222222-2222-4222-8222-222222222222";

function baseEmployee(overrides: Record<string, unknown> = {}) {
  return {
    sede_id: SEDE_A,
    full_name: "Carolina Rojas",
    document: "123456",
    pay_type: "fijo",
    salary_fixed: 1000000,
    ...overrides,
  };
}

describe("admin schemas: sede", () => {
  it("acepta sede con nombre y rechaza nombre vacío", () => {
    expect(sedeSchema.safeParse({ name: "Sede principal" }).success).toBe(true);
    expect(sedeSchema.safeParse({ name: "  " }).success).toBe(false);
  });
});

describe("admin schemas: empleado y pay_type coherente (ADM-08)", () => {
  it("fijo exige salary_fixed y rechaza comisión", () => {
    expect(baseEmployee().pay_type).toBe("fijo");
    expect(employeeSchema.safeParse(baseEmployee()).success).toBe(true);
    expect(employeeSchema.safeParse(baseEmployee({ full_name: "A" })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ full_name: "  " })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ payout_mode: "quincenal" })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ email: "no-es-correo" })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ birth_date: "mañana" })).success).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ birth_date: "2999-01-01" })).success).toBe(false);
    expect(
      employeeSchema.safeParse(
        baseEmployee({ payout_mode: "inmediato", email: "a@b.co", birth_date: "1990-05-01" }),
      ).success,
    ).toBe(true);
    expect(employeeSchema.safeParse(baseEmployee({ salary_fixed: null })).success).toBe(false);
    expect(
      employeeSchema.safeParse(baseEmployee({ commission_percent: 10 })).success,
    ).toBe(false);
  });

  it("porcentaje exige commission_percent y rechaza fijo", () => {
    expect(
      employeeSchema.safeParse(baseEmployee({ pay_type: "porcentaje", salary_fixed: null, commission_percent: 15 })).success,
    ).toBe(true);
    expect(
      employeeSchema.safeParse(baseEmployee({ pay_type: "porcentaje", salary_fixed: null })).success,
    ).toBe(false);
    expect(
      employeeSchema.safeParse(
        baseEmployee({ pay_type: "porcentaje", salary_fixed: 500000, commission_percent: 15 }),
      ).success,
    ).toBe(false);
  });

  it("mixto exige ambos montos", () => {
    expect(
      employeeSchema.safeParse(
        baseEmployee({ pay_type: "mixto", salary_fixed: 800000, commission_percent: 10 }),
      ).success,
    ).toBe(true);
    expect(
      employeeSchema.safeParse(
        baseEmployee({ pay_type: "mixto", salary_fixed: null, commission_percent: 10 }),
      ).success,
    ).toBe(false);
    expect(
      employeeSchema.safeParse(baseEmployee({ pay_type: "mixto", salary_fixed: 800000 })).success,
    ).toBe(false);
  });

  it("rechaza comisión fuera de 0–100 y salario negativo", () => {
    expect(
      employeeSchema.safeParse(
        baseEmployee({ pay_type: "porcentaje", salary_fixed: null, commission_percent: 101 }),
      ).success,
    ).toBe(false);
    expect(employeeSchema.safeParse(baseEmployee({ salary_fixed: -1 })).success).toBe(false);
  });

  it("checkPayCoherence describe cada caso", () => {
    expect(checkPayCoherence({ pay_type: "fijo", salary_fixed: 1, commission_percent: null })).toBeNull();
    expect(checkPayCoherence({ pay_type: "fijo", salary_fixed: null, commission_percent: null })).not.toBeNull();
    expect(
      checkPayCoherence({ pay_type: "porcentaje", salary_fixed: null, commission_percent: 5 }),
    ).toBeNull();
    expect(
      checkPayCoherence({ pay_type: "mixto", salary_fixed: 1, commission_percent: 5 }),
    ).toBeNull();
  });
});

describe("admin: unicidad parcial de employee_code (ADM-03)", () => {
  it("vacío/nulo/espacios se normalizan a null (repetible)", () => {
    expect(normalizeEmployeeCode(null)).toBeNull();
    expect(normalizeEmployeeCode(undefined)).toBeNull();
    expect(normalizeEmployeeCode("")).toBeNull();
    expect(normalizeEmployeeCode("   ")).toBeNull();
    expect(normalizeEmployeeCode(" EMP-01 ")).toBe("EMP-01");
    expect(isEmployeeCodeMissing("")).toBe(true);
    expect(isEmployeeCodeMissing("EMP-01")).toBe(false);
  });

  it("dos códigos con valor iguales en la misma sede colisionan", () => {
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: "EMP-01", sedeIdB: SEDE_A, codeB: "EMP-01" }),
    ).toBe(true);
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: "EMP-01", sedeIdB: SEDE_A, codeB: "EMP-02" }),
    ).toBe(false);
  });

  it("vacíos nunca colisionan y sedes distintas nunca colisionan", () => {
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: "", sedeIdB: SEDE_A, codeB: "" }),
    ).toBe(false);
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: null, sedeIdB: SEDE_A, codeB: "EMP-01" }),
    ).toBe(false);
    expect(
      areEmployeeCodesConflicting({ sedeIdA: SEDE_A, codeA: "EMP-01", sedeIdB: SEDE_B, codeB: "EMP-01" }),
    ).toBe(false);
  });

  it("el esquema acepta código vacío (repetible por sede)", () => {
    expect(employeeSchema.safeParse(baseEmployee({ employee_code: "" })).success).toBe(true);
    expect(employeeSchema.safeParse(baseEmployee({ employee_code: null })).success).toBe(true);
  });
});

describe("admin schemas: servicio min<=max (ADM-05)", () => {
  function baseService(overrides: Record<string, unknown> = {}) {
    return {
      sede_id: SEDE_A,
      name: "Corte",
      price: 50000,
      duracion_min: 30,
      duracion_max: 60,
      ...overrides,
    };
  }

  it("acepta rango válido e igual (min == max)", () => {
    expect(serviceSchema.safeParse(baseService()).success).toBe(true);
    expect(serviceSchema.safeParse(baseService({ duracion_min: 45, duracion_max: 45 })).success).toBe(
      true,
    );
  });

  it("rechaza min > max y valores negativos", () => {
    expect(serviceSchema.safeParse(baseService({ duracion_min: 90, duracion_max: 60 })).success).toBe(
      false,
    );
    expect(serviceSchema.safeParse(baseService({ price: -1 })).success).toBe(false);
    expect(serviceSchema.safeParse(baseService({ duracion_min: -5 })).success).toBe(false);
  });
});

describe("admin schemas: impuestos y métodos (ADM-06/ADM-07)", () => {
  it("percent acepta 0–100 y rechaza fuera de rango", () => {
    const base = { sede_id: SEDE_A, code: "IVA", name: "IVA general" };
    expect(taxConfigSchema.safeParse({ ...base, percent: 19 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: 0 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: 100 }).success).toBe(true);
    expect(taxConfigSchema.safeParse({ ...base, percent: -1 }).success).toBe(false);
    expect(taxConfigSchema.safeParse({ ...base, percent: 101 }).success).toBe(false);
    expect(taxConfigSchema.safeParse({ ...base, code: "OTRO", percent: 5 }).success).toBe(false);
  });

  it("solo acepta códigos del catálogo Colombia", () => {
    const base = { sede_id: SEDE_A, name: "Nequi" };
    for (const code of ["efectivo", "transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"]) {
      expect(paymentMethodSchema.safeParse({ ...base, code }).success).toBe(true);
    }
    expect(paymentMethodSchema.safeParse({ ...base, code: "bitcoin" }).success).toBe(false);
    expect(paymentMethodSchema.safeParse({ ...base, code: "PSE" }).success).toBe(false);
  });

  it("setUserRoles exige al menos un rol válido (ADM-04)", () => {
    expect(
      setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: ["admin"] }).success,
    ).toBe(true);
    expect(
      setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: ["empleado", "caja"] }).success,
    ).toBe(true);
    expect(setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: [] }).success).toBe(false);
    expect(setUserRolesSchema.safeParse({ user_id: SEDE_A, roles: ["dueño"] }).success).toBe(false);
  });
});

describe("admin: requireSedeRole y resolveSede (puros)", () => {
  it("admin pasa el gate de escritura; empleado/caja no", () => {
    expect(() => requireSedeRole(["admin"], ["admin"])).not.toThrow();
    expect(() => requireSedeRole(["empleado", "caja"], ["empleado", "caja"])).not.toThrow();
    try {
      requireSedeRole(["empleado"], ["admin"]);
      expect.unreachable("debió lanzar FORBIDDEN");
    } catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect((error as AdminError).code).toBe("FORBIDDEN");
      expect((error as AdminError).status).toBe(403);
    }
  });

  it("resolveSede usa la sede de la sesión y rechaza sede ajena", () => {
    expect(resolveSede(SEDE_A)).toBe(SEDE_A);
    expect(resolveSede(SEDE_A, SEDE_A)).toBe(SEDE_A);
    expect(() => resolveSede(SEDE_A, SEDE_B)).toThrowError(AdminError);
  });
});

describe("migración 003_admin.sql (T3)", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "003_admin.sql"), "utf8");

  it("crea las 5 tablas con triggers set_updated_at", () => {
    for (const table of ["sedes", "employees", "services", "tax_configs", "payment_methods"]) {
      expect(sql).toContain(`CREATE TABLE public.${table}`);
      expect(sql).toContain(`ENABLE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("set_updated_at()");
  });

  it("declara la unicidad parcial de employee_code solo con valor", () => {
    expect(sql).toContain("uq_employees_sede_code");
    expect(sql).toContain("WHERE employee_code IS NOT NULL");
  });

  it("vuelve users.sede_id NOT NULL con FK tras asignar la sede inicial", () => {
    expect(sql).toContain("Sede principal");
    expect(sql).toContain("ALTER COLUMN sede_id SET NOT NULL");
    expect(sql).toContain("fk_users_sede");
  });

  it("define RLS por sede con TODO documentado (políticas permisivas temporales)", () => {
    for (const policy of [
      "pol_sedes_sede_isolation",
      "pol_employees_sede_isolation",
      "pol_services_sede_isolation",
      "pol_tax_configs_sede_isolation",
      "pol_payment_methods_sede_isolation",
    ]) {
      expect(sql).toContain(`CREATE POLICY ${policy}`);
    }
    expect(sql).toContain("TODO(seguridad-T7)");
  });

  it("seed: 6 métodos de pago + IVA 19% e ICA inactivos", () => {
    for (const code of ["efectivo", "transferencia_normal", "nequi", "daviplata", "bre-b", "tarjeta"]) {
      expect(sql).toContain(code);
    }
    expect(sql).toContain("'IVA'");
    expect(sql).toContain("19");
    expect(sql).toContain("'ICA'");
  });
});
