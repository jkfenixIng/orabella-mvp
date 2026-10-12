import type { ActionResult } from "@/src/shared/lib/api-response";
import { bogotaDateOf } from "@/src/shared/lib/format";
import type { PayrollMonthEmployeeRow } from "@/src/features/payroll/schemas";

type MonthQuery = {
  month: string;
  employeeId: string;
  rows: PayrollMonthEmployeeRow[];
} | null;

type ExtraIdentity = { employee_id: string; paid_at: string };

export async function refreshPayrollMonthAfterExtra(args: {
  extra: ExtraIdentity;
  monthQuery: MonthQuery;
  loadRows: (input: { month: string; employeeId?: string }) => Promise<ActionResult<PayrollMonthEmployeeRow[]>>;
  loadOptions: () => Promise<ActionResult<string[]>>;
  show: <T>(result: ActionResult<T>) => result is { success: true; data: T };
  setMonthQuery: (query: Exclude<MonthQuery, null>) => void;
  setMonthOptions: (months: string[]) => void;
}): Promise<void> {
  const paidMonth = bogotaDateOf(args.extra.paid_at)?.slice(0, 7) ?? null;
  const queriedEmployee = args.monthQuery?.employeeId ?? null;
  if (paidMonth !== null && args.monthQuery?.month === paidMonth && (queriedEmployee === "" || queriedEmployee === args.extra.employee_id)) {
    const employeeId = queriedEmployee || undefined;
    const rows = await args.loadRows({ month: paidMonth, employeeId });
    if (rows.success) args.setMonthQuery({ month: paidMonth, employeeId: queriedEmployee ?? "", rows: rows.data });
    else {
      args.show({
        success: false,
        code: rows.code,
        message: `El pago extraordinario se registró, pero no se pudo actualizar Pagos del mes: ${rows.message}`,
      });
    }
  }

  const months = await args.loadOptions();
  if (months.success) args.setMonthOptions(months.data);
  else {
    args.show({
      success: false,
      code: months.code,
      message: `El pago extraordinario se registró, pero no se pudieron actualizar los meses: ${months.message}`,
    });
  }
}
