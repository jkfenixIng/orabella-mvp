import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listEmployees } from "@/src/features/admin/service";
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

  const [employees, settings, vouchers] = await Promise.all([
    listEmployees(sedeId),
    getVoucherSettings(sedeId),
    listVouchers(sedeId),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-3xl font-bold">Vales</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          Solicite vales para empleados con topes por día y semana.
        </p>
      </header>
      <VouchersClient
        initialEmployees={employees}
        initialSettings={settings}
        initialVouchers={vouchers}
        canAdmin={session.roles.includes("admin")}
      />
    </main>
  );
}
