import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listEmployees, listPaymentMethods } from "@/src/features/admin/service";
import { getOpenShiftWithOpener } from "@/src/features/cash/service";
import {
  getVoucherSettings,
  listVouchers,
} from "@/src/features/payroll/service";
import { VouchersClient } from "./vouchers-client";

export const dynamic = "force-dynamic";

/**
 * Vales como módulo propio (PERM-02): caja puede emitir vales sin entrar a
 * nómina; empleado ve los suyos (alcance en PERM-03); admin lo gestiona.
 */
export default async function ValesPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/vales");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-12">
        <h1 className="text-2xl font-bold">Vales</h1>
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const [employees, settings, vouchers, methods, shift] = await Promise.all([
    listEmployees(sedeId),
    getVoucherSettings(sedeId),
    listVouchers(sedeId),
    listPaymentMethods(sedeId),
    getOpenShiftWithOpener(sedeId),
  ]);

  const isAdmin = session.roles.includes("admin");
  const canIssue = isAdmin || session.roles.includes("caja");
  // La caja abierta es quien abre el vale: el cliente avisa temprano y el
  // servidor vuelve a validar (dueño del turno o admin).
  const shiftOpen = shift !== null;
  const shiftOwn = shift === null || shift.opened_by === session.user.id || isAdmin;
  const shiftOwner = shift?.opener_name?.trim() || null;
  // Empleado: solo sus vales y sin nómina de empleados (no ve el personal).
  const ownId = canIssue
    ? undefined
    : employees.find((row) => row.user_id === session.user.id)?.id ?? "sin-acceso";

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-3xl font-bold">Vales</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          La caja abre el vale al empleado con topes por día y semana, días permitidos y revisión del admin.
        </p>
      </header>
      <VouchersClient
        initialEmployees={canIssue ? employees : []}
        initialSettings={settings}
        initialVouchers={ownId ? vouchers.filter((row) => row.employee_id === ownId) : vouchers}
        initialMethods={methods.filter((row) => row.is_active && row.arqueable)}
        shiftOpen={shiftOpen}
        shiftOwn={shiftOwn}
        shiftOwner={shiftOwner}
        canAdmin={isAdmin}
        canIssue={canIssue}
      />
    </main>
  );
}
