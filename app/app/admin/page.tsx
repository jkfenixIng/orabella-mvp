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
import { Alert } from "@/src/components/ui/lib/alert";
import { PageContainer, PageHeader } from "@/src/components/ui/lib/page";
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
      <PageContainer size="narrow">
        <PageHeader title="Administración" />
        {/* Sin sede no hay panel que mostrar: es ESTADO (el caso hasta que a
            alguien se le asigne una sede), así que va inline y persistente.
            Esta vista es un Server Component: no puede emitir un toast. El
            texto es el mismo; `destructive` deriva role="alert", el mismo
            anuncio asertivo que antes estaba escrito a mano. */}
        <Alert variant="destructive">El usuario no tiene sede asignada.</Alert>
      </PageContainer>
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
    <PageContainer>
      <PageHeader
        title="Administración"
        description="Empleados, impuestos y métodos de pago de su sede."
      />
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
    </PageContainer>
  );
}
