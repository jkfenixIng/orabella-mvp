import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listPaymentMethods } from "@/src/features/admin/service";
import { getOpenShiftWithOpener, listRegisters } from "@/src/features/cash/service";
import type { DayView } from "@/src/features/cash/service";
import { accumulateDayTotals, bogotaDay, HISTORY_PAGE_SIZE } from "@/src/features/cash/schemas";
import { CashClient } from "./cash-client";

export const dynamic = "force-dynamic";

function isoDay(offsetDays: number): string {
  return bogotaDay(offsetDays);
}

/**
 * T6 — caja multi-turno (CAJ-01…06 + base encadenada). Lectura: cualquier
 * rol autenticado de su sede. Apertura/pagos/cierre: admin/caja (el
 * servidor lo refuerza en ambos casos).
 */
export default async function CashPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/cash");
  if (!session.roles.includes("admin") && !session.roles.includes("caja")) redirect("/");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-12">
        <h1 className="text-2xl font-bold">Caja</h1>
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const today = isoDay(0);
  // Entrada instantánea: solo registros + turno abierto. La vista del día
  // y el historial (solo admin) se cargan bajo demanda desde el cliente,
  // para no pagar ese costo al entrar solo a abrir o cerrar turno.
  const [registers, openShift, methods] = await Promise.all([
    listRegisters(sedeId),
    getOpenShiftWithOpener(sedeId),
    listPaymentMethods(sedeId),
  ]);

  // Día vacío inicial: el cliente lo pide solo si el usuario lo muestra.
  const emptyDay: DayView = {
    fecha: today,
    register: registers[0] ?? null,
    shifts: [],
    totals: accumulateDayTotals([]),
  };
  const rawDay = emptyDay;

  const canWrite = session.roles.includes("admin") || session.roles.includes("caja");
  const isAdmin = session.roles.includes("admin");
  // Caja ve solo sus turnos en la vista del día (el servidor refuerza lo mismo).
  const dayShifts = isAdmin ? rawDay.shifts : rawDay.shifts.filter((view) => view.shift.opened_by === session.user.id);
  const day = isAdmin
    ? rawDay
    : {
        ...rawDay,
        shifts: dayShifts,
        totals: accumulateDayTotals(
          dayShifts.map((view) => ({
            expectedCash: view.efectivo,
            countedCash: view.shift.counted_cash,
            baseLeft: view.shift.base_left,
            cashWithdrawn: view.shift.cash_withdrawn,
            baseDifference: view.shift.base_difference,
            ventas: view.ventas,
          })),
        ),
      };

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Caja</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Turnos, pagos por método y cierres de caja.
          </p>
        </div>
      </header>
      <CashClient
        sedeId={sedeId}
        today={today}
        currentUserId={session.user.id}
        initialRegisters={registers}
        initialOpenShift={openShift}
        initialOpenerName={openShift?.opener_name ?? null}
        initialDay={day}
        initialHistory={{ desde: today, hasta: today, shifts: [], page: 1, pageSize: HISTORY_PAGE_SIZE, total: 0 }}
        methods={methods.filter((row) => row.is_active)}
        canWrite={canWrite}
        isAdmin={isAdmin}
      />
    </main>
  );
}
