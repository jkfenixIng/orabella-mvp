import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert } from "@/src/components/ui/lib/alert";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
import { SESSION_COOKIE_NAME } from "@/src/features/auth/constants";
import { getSessionUser } from "@/src/features/auth/service";
import {
  listProducts,
} from "@/src/features/inventory/service";
import { filterLowStock } from "@/src/features/inventory/schemas";
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
  if (!session.roles.includes("admin") && !session.roles.includes("caja")) redirect("/");

  const sedeId = session.user.sede_id;
  if (!sedeId) {
    return (
      <PageContainer size="narrow">
        <PageHeader title="Inventario" />
        {/* Sin sede no hay inventario que mostrar: es ESTADO (el caso hasta
            que a alguien se le asigne una sede), así que va inline y
            persistente. Esta vista es un Server Component: no puede emitir un
            toast. El texto es el mismo; `destructive` deriva role="alert", el
            mismo anuncio asertivo que antes estaba escrito a mano. */}
        <Alert variant="destructive">El usuario no tiene sede asignada.</Alert>
      </PageContainer>
    );
  }

  // Una sola query: las alertas se derivan del listado (misma regla
  // stock <= mínimo que filterLowStock), sin segundo scan completo.
  const products = await listProducts(sedeId);
  const alertIds = new Set(filterLowStock(products).map((alert) => alert.id));
  const canWrite = session.roles.includes("admin") || session.roles.includes("caja");
  const canAdmin = session.roles.includes("admin");

  return (
    <PageContainer>
      <PageHeader
        title="Inventario"
        description="Productos, stock, kardex y alertas de mínimo de su sede."
      />
      <InventoryClient
        sedeId={sedeId}
        initialProducts={products}
        initialAlertIds={[...alertIds]}
        canWrite={canWrite}
        canAdmin={canAdmin}
      />
    </PageContainer>
  );
}
