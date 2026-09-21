import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listPaymentMethods } from "@/src/features/admin/service";
import { getDayView, getOpenShift, listRegisters } from "@/src/features/cash/service";
import { CashClient } from "./cash-client";

export const dynamic = "force-dynamic";

function isoDay(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  // Entrada instantánea: solo registros + turno abierto + día. El
  // historial (30 días) se carga bajo demanda con el filtro del cliente.
  const [registers, openShift, day, methods] = await Promise.all([
    listRegisters(sedeId),
    getOpenShift(sedeId),
    getDayView(sedeId, { fecha: today }),
    listPaymentMethods(sedeId),
  ]);

  const canWrite = session.roles.includes("admin") || session.roles.includes("caja");

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Caja</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Turnos con base encadenada, pagos por método y cierre con arqueo.
          </p>
        </div>
      </header>
      <CashClient
        sedeId={sedeId}
        today={today}
        initialRegisters={registers}
        initialOpenShift={openShift}
        initialDay={day}
        initialHistory={{ desde: today, hasta: today, shifts: [] }}
        methods={methods.filter((row) => row.is_active)}
        canWrite={canWrite}
      />
    </main>
  );
}
