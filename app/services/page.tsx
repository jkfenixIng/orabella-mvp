import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert } from "@/src/components/ui/lib/alert";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
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
      <PageContainer size="narrow">
        <PageHeader title="Servicios" />
        {/* Sin sede no hay catálogo que mostrar: es ESTADO (el caso hasta que
            a alguien se le asigne una sede), así que va inline y persistente.
            Esta vista es un Server Component: no puede emitir un toast. El
            texto es el mismo; `destructive` deriva role="alert", el mismo
            anuncio asertivo que antes estaba escrito a mano. */}
        <Alert variant="destructive">El usuario no tiene sede asignada.</Alert>
      </PageContainer>
    );
  }

  const services = await listServices();
  const canWrite = session.roles.includes("admin");

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Servicios"
        description="Catálogo de servicios de la sede: qué se brinda, con precio y duración estimada."
      />
      <ServicesClient initialServices={services} canWrite={canWrite} />
    </PageContainer>
  );
}
