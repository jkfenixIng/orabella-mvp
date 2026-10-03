import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Alert } from "@/src/components/ui/lib/alert";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
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
      <PageContainer size="narrow">
        <PageHeader title="Alertas" />
        {/* Sin sede no hay bandeja que mostrar: es ESTADO (el caso hasta que a
            alguien se le asigne una sede), así que va inline y persistente.
            Esta vista es un Server Component: no puede emitir un toast. El
            texto es el mismo; `destructive` deriva role="alert", el mismo
            anuncio asertivo que antes estaba escrito a mano. */}
        <Alert variant="destructive">El usuario no tiene sede asignada.</Alert>
      </PageContainer>
    );
  }

  const initial = await listAlerts({ unreadOnly: true, page: 1 });

  return (
    <PageContainer size="wide">
      <PageHeader
        title="Alertas"
        description="Desajustes de caja y cuentas bloqueadas de su sede."
      />
      <AlertsClient initial={initial} />
    </PageContainer>
  );
}
