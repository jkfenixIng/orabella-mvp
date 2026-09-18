import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import {
  listProducts,
  lowStockAlerts,
} from "@/src/features/inventory/service";
import { ThemeToggle } from "@/src/shared/components/theme-toggle";
import { InventoryClient } from "./inventory-client";

export const dynamic = "force-dynamic";

/**
 * T4 — inventario (INV-01…05). Lectura: cualquier rol autenticado de su
 * sede. La escritura (crear/editar/movimientos) la gatinga el cliente
 * según rol y la refuerza el servidor (solo admin/caja).
 */
export default async function InventoryPage() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  const session = await getSessionUser(token);
  if (!session) redirect("/login?next=/inventory");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 px-6 py-12">
        <h1 className="text-2xl font-bold">Inventario</h1>
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          El usuario no tiene sede asignada.
        </p>
      </main>
    );
  }

  const [products, alerts] = await Promise.all([
    listProducts(sedeId),
    lowStockAlerts(sedeId),
  ]);
  const alertIds = new Set(alerts.map((alert) => alert.id));
  const canWrite = session.roles.includes("admin") || session.roles.includes("caja");

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Inventario</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-300">
            Productos, stock, kardex y alertas de mínimo de su sede.
          </p>
        </div>
        <ThemeToggle />
      </header>
      <InventoryClient
        sedeId={sedeId}
        initialProducts={products}
        initialAlertIds={[...alertIds]}
        canWrite={canWrite}
      />
    </main>
  );
}
