import { describe, expect, it, vi } from "vitest";

import { refreshPayrollMonthAfterExtra } from "@/app/payroll/payroll-month-refresh";
import type { ActionResult } from "@/src/shared/lib/api-response";
import type { PayrollMonthEmployeeRow } from "@/src/features/payroll/schemas";

const EXTRA = { employee_id: "emp-01", paid_at: "2026-10-01T00:30:00Z" };
const QUERY = { month: "2026-09", employeeId: "emp-01", rows: [] as PayrollMonthEmployeeRow[] };

function failure(message: string): ActionResult<never> {
  return { success: false, code: "INTERNAL", message };
}

describe("pago extraordinario: refresco posterior", () => {
  it("reporta el fallo de las filas y de los meses sin reemplazar la consulta", async () => {
    const shown: ActionResult<unknown>[] = [];
    const show = <T,>(result: ActionResult<T>): result is { success: true; data: T } => {
      shown.push(result);
      return result.success;
    };
    const setMonthQuery = vi.fn();
    const setMonthOptions = vi.fn();
    const pay = vi.fn();

    await refreshPayrollMonthAfterExtra({
      extra: EXTRA,
      monthQuery: QUERY,
      loadRows: async () => failure("filas no disponibles"),
      loadOptions: async () => failure("meses no disponibles"),
      show,
      setMonthQuery,
      setMonthOptions,
    });

    expect(shown).toEqual([
      failure("El pago extraordinario se registró, pero no se pudo actualizar Pagos del mes: filas no disponibles"),
      failure("El pago extraordinario se registró, pero no se pudieron actualizar los meses: meses no disponibles"),
    ]);
    expect(setMonthQuery).not.toHaveBeenCalled();
    expect(setMonthOptions).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
  });

  it("no consulta filas cuando la vista muestra otro mes", async () => {
    const loadRows = vi.fn();

    await refreshPayrollMonthAfterExtra({
      extra: EXTRA,
      monthQuery: { ...QUERY, month: "2026-10" },
      loadRows,
      loadOptions: async () => ({ success: true, data: ["2026-10", "2026-09"] }),
      show: <T,>(result: ActionResult<T>): result is { success: true; data: T } => result.success,
      setMonthQuery: vi.fn(),
      setMonthOptions: vi.fn(),
    });

    expect(loadRows).not.toHaveBeenCalled();
  });
});
