import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import { listServices } from "@/src/features/admin/service";
import { ServicesClient } from "./services-client";

export const dynamic = "force-dynamic";

/**
 * S1: servicios como catálogo propio de la sede, fuera del panel de admin.
 * Es un CRUD de "qué se brinda" (precio y duración estimada), no un
 * inventario de cantidades: no hay stock ni movimientos.
 */
export default async function ServicesPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/services");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-12">
        <h1 className="text-2xl font-bold">Servicios</h1>
        <p role="alert" className="text-sm text-error dark:text-error">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const services = await listServices(sedeId);
  const canWrite = session.roles.includes("admin");

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <header>
        <h1 className="text-3xl font-bold">Servicios</h1>
        <p className="mt-2 text-text-secondary">
          Catálogo de servicios de la sede: qué se brinda, con precio y duración estimada.
        </p>
      </header>
      <ServicesClient sedeId={sedeId} initialServices={services} canWrite={canWrite} />
    </main>
  );
}
