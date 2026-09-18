import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import {
  listEmployees,
  listPaymentMethods,
  listServices,
  listTaxes,
} from "@/src/features/admin/service";
import { ThemeToggle } from "@/src/shared/components/theme-toggle";
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
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const [employees, services, taxes, methods] = await Promise.all([
    listEmployees(sedeId),
    listServices(sedeId),
    listTaxes(sedeId),
    listPaymentMethods(sedeId),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Administración</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Empleados, servicios, impuestos y métodos de pago de su sede.
          </p>
        </div>
        <ThemeToggle />
      </header>
      <AdminTabs
        sedeId={sedeId}
        initialEmployees={employees}
        initialServices={services}
        initialTaxes={taxes}
        initialMethods={methods}
      />
    </main>
  );
}
