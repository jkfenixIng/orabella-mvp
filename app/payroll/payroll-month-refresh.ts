import type { ActionResult } from "@/src/shared/lib/api-response";
import { bogotaDateOf } from "@/src/shared/lib/format";
import type { PayrollMonthEmployeeRow } from "@/src/features/payroll/schemas";

type MonthQuery = {
  month: string;
  employeeId: string;
  search: string;
  rows: PayrollMonthEmployeeRow[];
  total: number;
} | null;

type ExtraIdentity = { employee_id: string; paid_at: string };

export async function refreshPayrollMonthAfterExtra(args: {
  extra: ExtraIdentity;
  monthQuery: MonthQuery;
  /** Current server page; the refresh re-reads that same page and criteria. */
  page: number;
  loadRows: (input: {
    month: string;
    employeeId?: string;
    search: string;
    page: number;
    limit: number;
  }) => Promise<ActionResult<{ rows: PayrollMonthEmployeeRow[]; total: number }>>;
  pageSize: number;
  loadOptions: () => Promise<ActionResult<string[]>>;
  show: <T>(result: ActionResult<T>) => result is { success: true; data: T };
  setMonthQuery: (query: Exclude<MonthQuery, null>) => void;
  setMonthOptions: (months: string[]) => void;
}): Promise<void> {
  const paidMonth = bogotaDateOf(args.extra.paid_at)?.slice(0, 7) ?? null;
  const query = args.monthQuery;
  if (paidMonth !== null && query !== null && query.month === paidMonth && (query.employeeId === "" || query.employeeId === args.extra.employee_id)) {
    const rows = await args.loadRows({
      month: paidMonth,
      employeeId: query.employeeId || undefined,
      search: query.search,
      page: args.page,
      limit: args.pageSize,
    });
    if (rows.success) args.setMonthQuery({ ...query, rows: rows.data.rows, total: rows.data.total });
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
