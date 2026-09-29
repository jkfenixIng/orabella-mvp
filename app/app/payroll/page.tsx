import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert } from "@/src/components/ui/lib/alert";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listEmployees, listPaymentMethods } from "@/src/features/admin/service";
import { listPeriods } from "@/src/features/payroll/service";
import { PayrollClient } from "./payroll-client";

export const dynamic = "force-dynamic";

/**
 * T7 — nómina y vales (PAY-01…07).
 *
 * Nómina: la administra el admin de la sede; el empleado entra a ver SU recibo
 * (periodo y detalle con alcance por fila). La caja no entra —ni la página ni el
 * API—: el módulo de nómina es del administrador, que es quien la genera y la
 * revisa. El vale de la caja vive en /vales.
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
        {/* Sin sede no hay nómina que mostrar: es ESTADO (el caso hasta que a
            alguien se le asigne una sede), así que va inline y persistente.
            Esta vista es un Server Component: no puede emitir un toast. El
            texto es el mismo; `destructive` deriva role="alert", el mismo
            anuncio asertivo que antes estaba escrito a mano. */}
        <Alert variant="destructive">El usuario no tiene sede asignada.</Alert>
      </main>
    );
  }

  const [employees, periods, methods] = await Promise.all([
    listEmployees(sedeId),
    listPeriods(sedeId),
    listPaymentMethods(sedeId),
  ]);

  const canAdmin = session.roles.includes("admin");
  // Pagar un ítem es del admin igual que el resto del módulo: el guard del
  // servidor (requirePayrollAdmin) y el botón no pueden decir cosas distintas
  // (antes `canPay` sumaba `caja` en una página que a la caja la redirige arriba).
  const canPay = canAdmin;

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Nómina</h1>
          <p className="mt-2 text-text-secondary">
            Periodos con cálculo desde facturación y pago por porciones.
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
