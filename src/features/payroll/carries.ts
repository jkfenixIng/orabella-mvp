/**
 * NV-01/NV-02: pure arithmetic of payroll discount carries.
 *
 * The application decides which debts enter a period and how much of them the
 * discount cap absorbs. `payroll_apply_atomic` remains the only writer: it marks
 * the consumed carries under lock and refuses duplicates, so a replay is a no-op.
 */
import { capPayrollDiscounts, roundMoney } from "./schemas";

export interface CarryRow {
  id: string;
  employee_id: string;
  amount: number | string;
  origin_period_id: string;
}

export interface IncomingCarryPlan {
  /** Applicable debt per employee, summed into `other_discounts`. */
  debtByEmployee: Map<string, number>;
  /** Pending carry ids this calculation consumes (payable employees only). */
  carriesToApply: string[];
}

/**
 * A carry applies only when its origin period ends strictly before the period
 * being calculated. Rows already applied here are re-counted on recalculation
 * but never re-marked; carries of employees outside this cadence are not consumed.
 */
export function planIncomingCarries(args: {
  pending: readonly CarryRow[];
  appliedHere: readonly CarryRow[];
  originEndById: ReadonlyMap<string, string>;
  periodStart: string;
  payableEmployeeIds: ReadonlySet<string>;
}): IncomingCarryPlan {
  const isEarlier = (row: CarryRow): boolean => {
    const originEnd = args.originEndById.get(row.origin_period_id);
    return originEnd !== undefined && originEnd < args.periodStart;
  };
  const debtByEmployee = new Map<string, number>();
  for (const row of [...args.pending, ...args.appliedHere]) {
    if (!isEarlier(row)) continue;
    debtByEmployee.set(
      row.employee_id,
      roundMoney((debtByEmployee.get(row.employee_id) ?? 0) + Number(row.amount)),
    );
  }
  const carriesToApply = args.pending
    .filter((row) => isEarlier(row) && args.payableEmployeeIds.has(row.employee_id))
    .map((row) => row.id);
  return { debtByEmployee, carriesToApply };
}

export interface CarrySettlement {
  /** Total `other_discounts` before the cap (manual + incoming debt). */
  otherDiscounts: number;
  appliedVales: number;
  appliedOtherDiscounts: number;
  /** Voucher amount the cap could not apply: a new debt for a later period. */
  voucherExcess: number;
  /** Incoming debt the cap could not absorb: re-registered as pending. */
  debtRemainder: number;
}

/**
 * Caps discounts to the gross pay and splits the incoming debt into what the
 * net absorbed and what remains pending. Nothing is forgiven:
 * absorbed + remainder === incomingDebt.
 */
export function settlePayrollCarries(args: {
  gross: number;
  vales: number;
  manualOtherDiscounts: number;
  incomingDebt: number;
}): CarrySettlement {
  const otherDiscounts = roundMoney(args.manualOtherDiscounts + args.incomingDebt);
  const applied = capPayrollDiscounts({ gross: args.gross, vales: args.vales, otherDiscounts });
  const voucherExcess = roundMoney(Math.max(0, args.vales - applied.vales));
  const absorbedDebt = roundMoney(
    Math.max(
      0,
      Math.min(args.incomingDebt, roundMoney(applied.otherDiscounts - args.manualOtherDiscounts)),
    ),
  );
  return {
    otherDiscounts,
    appliedVales: applied.vales,
    appliedOtherDiscounts: applied.otherDiscounts,
    voucherExcess,
    debtRemainder: roundMoney(args.incomingDebt - absorbedDebt),
  };
}
