import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listEmployees, listPaymentMethods } from "@/src/features/admin/service";
import { listPeriods } from "@/src/features/payroll/service";
import { PayrollClient } from "./payroll-client";

export const dynamic = "force-dynamic";

/**
 * T7 — nómina y vales (PAY-01…07). Lectura: cualquier rol autenticado de
 * su sede. Periodos/cálculo/cierre/vales-aprobación: admin (el servidor
 * lo refuerza en ambos casos); pagar admite también caja.
 */
export default async function PayrollPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/payroll");
  if (!session.roles.includes("admin") && !session.roles.includes("empleado")) redirect("/");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-12">
        <h1 className="text-2xl font-bold">Nómina</h1>
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const [employees, periods, methods] = await Promise.all([
    listEmployees(sedeId),
    listPeriods(sedeId),
    listPaymentMethods(sedeId),
  ]);

  const canAdmin = session.roles.includes("admin");
  const canPay = canAdmin || session.roles.includes("caja");

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Nómina y vales</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Periodos con cálculo desde facturación, pago por porciones y vales con topes.
          </p>
        </div>
      </header>
      <PayrollClient
        sedeId={sedeId}
        initialEmployees={employees}
        initialPeriods={periods}
        methods={methods.filter((row) => row.is_active)}
        canAdmin={canAdmin}
        canPay={canPay}
      />
    </main>
  );
}
