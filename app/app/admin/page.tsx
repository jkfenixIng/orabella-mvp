import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import {
  listEmployees,
  listPaymentMethods,
  listSedeUsers,
  listTaxes,
} from "@/src/features/admin/service";
import { getVoucherSettings } from "@/src/features/payroll/service";
import { listDenominations, listRegisters } from "@/src/features/cash/service";
import { AdminTabs } from "./admin-tabs";

export const dynamic = "force-dynamic";

/**
 * Panel admin. Solo rol admin: quien no lo tenga es redirigido al
 * inicio. La validación vive aquí (servidor con BD) y no en el
 * middleware, porque la cookie de sesión es un token opaco que no
 * porta el rol (ver decisión documentada en middleware.ts).
 * Carga inicial en servidor con el mismo servicio que la API.
 */
export default async function AdminPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/admin");

  if (!session.roles.includes("admin")) redirect("/");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-12">
        <h1 className="text-2xl font-bold">Administración</h1>
        <p role="alert" className="text-sm text-error dark:text-error">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const [employees, users, taxes, methods, voucherSettings, registers, denominations] =
    await Promise.all([
      listEmployees(sedeId),
      listSedeUsers(sedeId),
      listTaxes(sedeId),
      listPaymentMethods(sedeId),
      getVoucherSettings(sedeId),
      listRegisters(sedeId),
      listDenominations(sedeId),
    ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Administración</h1>
          <p className="mt-2 text-text-secondary">
            Empleados, impuestos y métodos de pago de su sede.
          </p>
        </div>
      </header>
      <AdminTabs
        sedeId={sedeId}
        currentUserId={session.user.id}
        initialEmployees={employees}
        initialUsers={users}
        initialTaxes={taxes}
        initialMethods={methods}
        initialVoucherSettings={voucherSettings}
        initialRegisters={registers}
        initialDenominations={denominations}
      />
    </main>
  );
}
