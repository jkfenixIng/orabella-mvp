import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listAlerts } from "@/src/features/alerts/service";
import { AlertsClient } from "./alerts-client";

export const dynamic = "force-dynamic";

/**
 * Bandeja del admin: desajustes de caja y cuentas bloqueadas, más
 * recientes primero. Solo rol admin de su sede.
 */
export default async function AlertsPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/alerts");
  if (!session.roles.includes("admin")) redirect("/");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-12">
        <h1 className="text-2xl font-bold">Alertas</h1>
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const initial = await listAlerts(
    sedeId,
    { unreadOnly: false, page: 1 },
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-3xl font-bold">Alertas</h1>
        <p className="mt-2 text-slate-600 dark:text-slate-300">
          Desajustes de caja y cuentas bloqueadas de su sede.
        </p>
      </header>
      <AlertsClient initial={initial} />
    </main>
  );
}
