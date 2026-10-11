/** PostgreSQL numeric `round()` semantics: halves are away from zero. */
export function postgresNumericRound(value: number): number {
  const rounded = value < 0 ? -Math.round(-value) : Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

export interface MoneyCapInput {
  alreadyPaid: number;
  incoming: number;
  cap: number;
}

/**
 * Cap policy for new COP writes and preserved legacy cents: compare the rounded
 * whole-peso totals. New values are already whole pesos; legacy values are read
 * without mutation and projected into the terminal's whole-peso unit.
 */
export function moneyCapExceeded({ alreadyPaid, incoming, cap }: MoneyCapInput): boolean {
  return postgresNumericRound(alreadyPaid + incoming) > postgresNumericRound(cap);
}

export const invoicePaymentCapExceeded = moneyCapExceeded;
export const payrollPaymentCapExceeded = moneyCapExceeded;
export const commissionPayoutCapExceeded = moneyCapExceeded;

/** The cash minimum is also a whole-peso comparison, including its 50% floor. */
export function cashMinimumBreached(openingBase: number, expectedBalance: number, outgoing: number): boolean {
  return (
    postgresNumericRound(expectedBalance) - postgresNumericRound(outgoing) <
    postgresNumericRound(postgresNumericRound(openingBase) * 0.5)
  );
}
